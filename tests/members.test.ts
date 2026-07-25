import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const PUBLIC_ORIGIN = "http://localhost";
const FOREIGN_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Fixture {
  app: FastifyInstance;
  database: Database;
  ownerToken: string;
}

interface InvitationResult {
  member: {
    id: string;
    phone: string;
    displayName: string;
    role: "owner" | "finance" | "sales" | "viewer";
    active: boolean;
    status: string;
  };
  invitation: { token: string; expiresAt: string };
}

async function createFixture(): Promise<Fixture> {
  const database = await createPgliteDatabase(":memory:");
  await migrate(database);
  await seedDemo(database);
  const app = buildApp({ database, closeDatabase: true, publicOrigin: PUBLIC_ORIGIN });
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { phone: "13800000000", password: "demo1234" },
  });
  if (login.statusCode !== 200) throw new Error("owner fixture login failed");
  return { app, database, ownerToken: login.json().token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function inviteMember(
  fixture: Fixture,
  input: {
    phone?: string;
    displayName?: string;
    role?: "owner" | "finance" | "sales" | "viewer";
  } = {},
): Promise<InvitationResult> {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/members",
    headers: bearer(fixture.ownerToken),
    payload: {
      phone: input.phone ?? "13900000001",
      displayName: input.displayName ?? "新成员",
      role: input.role ?? "viewer",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function acceptInvitation(app: FastifyInstance, token: string, password = "member-password-2026") {
  return app.inject({
    method: "POST",
    url: "/api/auth/accept-invitation",
    payload: { token, password },
  });
}

describe.sequential("member and role administration", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.app.close();
  });

  it("returns a tenant-scoped member list and rejects every non-owner administration route", async () => {
    await fixture.database.transaction(async (tx) => {
      await tx.query("INSERT INTO tenants (id, name) VALUES ($1, '其他企业')", [FOREIGN_TENANT_ID]);
      await tx.query(
        "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13100000000', '其他企业负责人', 'not-used')",
        [FOREIGN_USER_ID],
      );
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
        [FOREIGN_TENANT_ID, FOREIGN_USER_ID],
      );
    });
    const invited = await inviteMember(fixture, { role: "viewer" });
    expect((await acceptInvitation(fixture.app, invited.invitation.token)).statusCode).toBe(200);
    const viewerLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(viewerLogin.statusCode).toBe(200);
    const viewerToken = viewerLogin.json().token;

    const ownerList = await fixture.app.inject({
      method: "GET",
      url: "/api/members",
      headers: bearer(fixture.ownerToken),
    });
    expect(ownerList.statusCode).toBe(200);
    expect(ownerList.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: DEMO_IDS.user, role: "owner", active: true }),
      expect.objectContaining({ id: invited.member.id, role: "viewer", active: true }),
    ]));
    expect(JSON.stringify(ownerList.json())).not.toContain("password_hash");
    expect(JSON.stringify(ownerList.json())).not.toContain(invited.invitation.token);
    expect(JSON.stringify(ownerList.json())).not.toContain(FOREIGN_USER_ID);

    const crossTenantMutation = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${FOREIGN_USER_ID}/role`,
      headers: bearer(fixture.ownerToken),
      payload: { role: "viewer" },
    });
    expect(crossTenantMutation.statusCode).toBe(404);
    const foreignMembership = await fixture.database.query<{ role: string }>(
      "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
      [FOREIGN_TENANT_ID, FOREIGN_USER_ID],
    );
    expect(foreignMembership.rows[0]?.role).toBe("owner");

    const forbiddenRequests = await Promise.all([
      fixture.app.inject({ method: "GET", url: "/api/members", headers: bearer(viewerToken) }),
      fixture.app.inject({
        method: "POST",
        url: "/api/members",
        headers: bearer(viewerToken),
        payload: { phone: "13900000002", displayName: "越权成员", role: "sales" },
      }),
      fixture.app.inject({
        method: "PATCH",
        url: `/api/members/${DEMO_IDS.user}/role`,
        headers: bearer(viewerToken),
        payload: { role: "viewer" },
      }),
      fixture.app.inject({
        method: "PATCH",
        url: `/api/members/${DEMO_IDS.user}/status`,
        headers: bearer(viewerToken),
        payload: { active: false },
      }),
      fixture.app.inject({
        method: "POST",
        url: `/api/members/${DEMO_IDS.user}/reinvite`,
        headers: bearer(viewerToken),
      }),
    ]);
    expect(forbiddenRequests.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403]);
  });

  it("stores only an invitation digest, activates it once, and never audits credentials", async () => {
    const invited = await inviteMember(fixture, { role: "finance", displayName: "邀请财务" });
    expect(invited.member).toMatchObject({ role: "finance", active: false, status: "invited" });
    expect(invited.invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await fixture.database.query<{ token_hash: string }>(
      "SELECT token_hash FROM member_invitations WHERE tenant_id = $1 AND user_id = $2",
      [DEMO_IDS.tenant, invited.member.id],
    );
    expect(stored.rows[0]?.token_hash.trim()).toBe(
      createHash("sha256").update(invited.invitation.token).digest("hex"),
    );
    expect(stored.rows[0]?.token_hash.trim()).not.toBe(invited.invitation.token);

    const beforeAcceptance = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(beforeAcceptance.statusCode).toBe(401);
    const shortPassword = await acceptInvitation(fixture.app, invited.invitation.token, "too-short");
    expect(shortPassword.statusCode).toBe(400);
    const invalidToken = await acceptInvitation(fixture.app, "A".repeat(43));
    expect(invalidToken.statusCode).toBe(400);

    const accepted = await acceptInvitation(fixture.app, invited.invitation.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      success: true,
      member: { userId: invited.member.id, role: "finance" },
    });
    const replay = await acceptInvitation(fixture.app, invited.invitation.token);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("INVALID_INVITATION");

    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().role).toBe("finance");

    const audit = await fixture.database.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs
       WHERE tenant_id = $1 AND entity_id = $2
       ORDER BY created_at, id`,
      [DEMO_IDS.tenant, invited.member.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "member.invited",
      "member.invitation_accepted",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(invited.invitation.token);
    expect(JSON.stringify(audit.rows)).not.toContain("member-password-2026");
  });

  it("rejects expired invitations, duplicate phones, pending activation, and malformed input", async () => {
    const invited = await inviteMember(fixture);
    await fixture.database.query(
      `UPDATE member_invitations
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE tenant_id = $1 AND user_id = $2`,
      [DEMO_IDS.tenant, invited.member.id],
    );
    const expired = await acceptInvitation(fixture.app, invited.invitation.token);
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe("INVALID_INVITATION");

    const pendingActivation = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: true },
    });
    expect(pendingActivation.statusCode).toBe(409);
    expect(pendingActivation.json().error.code).toBe("MEMBER_INVITATION_PENDING");

    const revoked = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: false },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      member: { active: false, status: "inactive", invitation: { status: "revoked" } },
      idempotentReplay: false,
    });
    expect((await acceptInvitation(fixture.app, invited.invitation.token)).statusCode).toBe(400);

    const reinvited = await fixture.app.inject({
      method: "POST",
      url: `/api/members/${invited.member.id}/reinvite`,
      headers: bearer(fixture.ownerToken),
    });
    expect(reinvited.statusCode).toBe(200);
    expect(reinvited.json()).toMatchObject({
      member: { active: false, status: "invited", invitation: { status: "pending" } },
    });
    expect(reinvited.json().invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reinvited.json().invitation.token).not.toBe(invited.invitation.token);
    expect((await acceptInvitation(fixture.app, invited.invitation.token)).statusCode).toBe(400);
    expect((await acceptInvitation(fixture.app, reinvited.json().invitation.token)).statusCode).toBe(200);
    const alreadyActivated = await fixture.app.inject({
      method: "POST",
      url: `/api/members/${invited.member.id}/reinvite`,
      headers: bearer(fixture.ownerToken),
    });
    expect(alreadyActivated.statusCode).toBe(409);
    expect(alreadyActivated.json().error.code).toBe("MEMBER_ALREADY_ACTIVATED");

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/api/members",
      headers: bearer(fixture.ownerToken),
      payload: { phone: "13800000000", displayName: "重复手机号", role: "viewer" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("MEMBER_PHONE_IN_USE");

    const malformed = await fixture.app.inject({
      method: "POST",
      url: "/api/members",
      headers: bearer(fixture.ownerToken),
      payload: { phone: "1", displayName: "", role: "administrator", unexpected: true },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("changes roles, deactivates and restores members, and revokes their sessions", async () => {
    const invited = await inviteMember(fixture, { role: "finance" });
    expect((await acceptInvitation(fixture.app, invited.invitation.token)).statusCode).toBe(200);
    const memberLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(memberLogin.statusCode).toBe(200);
    const memberToken = memberLogin.json().token;

    const sameRole = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/role`,
      headers: bearer(fixture.ownerToken),
      payload: { role: "finance" },
    });
    expect(sameRole.statusCode).toBe(200);
    expect(sameRole.json().idempotentReplay).toBe(true);
    const changedRole = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/role`,
      headers: bearer(fixture.ownerToken),
      payload: { role: "sales" },
    });
    expect(changedRole.statusCode).toBe(200);
    expect(changedRole.json()).toMatchObject({ member: { role: "sales" }, idempotentReplay: false });

    const deactivated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({
      member: { active: false, status: "inactive" },
      idempotentReplay: false,
    });
    expect(deactivated.json().revokedSessions).toBeGreaterThanOrEqual(1);
    const revokedSession = await fixture.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: bearer(memberToken),
    });
    expect(revokedSession.statusCode).toBe(401);
    const disabledLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(disabledLogin.statusCode).toBe(401);

    const repeated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: false },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().idempotentReplay).toBe(true);
    const restored = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${invited.member.id}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: true },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ member: { active: true }, idempotentReplay: false });
    const restoredLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(restoredLogin.statusCode).toBe(200);

    const audit = await fixture.database.query<{ action: string }>(
      `SELECT action FROM audit_logs
       WHERE tenant_id = $1 AND entity_id = $2
       ORDER BY created_at, id`,
      [DEMO_IDS.tenant, invited.member.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "member.role_changed",
      "member.deactivated",
      "member.reactivated",
    ]));
  });

  it("serializes invitation acceptance with owner revocation and leaves the member disabled", async () => {
    const invited = await inviteMember(fixture, { phone: "13900000008" });
    const [acceptance, revocation] = await Promise.all([
      acceptInvitation(fixture.app, invited.invitation.token),
      fixture.app.inject({
        method: "PATCH",
        url: `/api/members/${invited.member.id}/status`,
        headers: bearer(fixture.ownerToken),
        payload: { active: false },
      }),
    ]);
    expect([200, 400]).toContain(acceptance.statusCode);
    expect(revocation.statusCode).toBe(200);
    const membership = await fixture.database.query<{ is_active: boolean }>(
      "SELECT is_active FROM memberships WHERE tenant_id = $1 AND user_id = $2",
      [DEMO_IDS.tenant, invited.member.id],
    );
    expect(membership.rows[0]?.is_active).toBe(false);
    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invited.member.phone, password: "member-password-2026" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("keeps one active owner under both direct and concurrent demotion attempts", async () => {
    const directRole = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${DEMO_IDS.user}/role`,
      headers: bearer(fixture.ownerToken),
      payload: { role: "finance" },
    });
    expect(directRole.statusCode).toBe(409);
    expect(directRole.json().error.code).toBe("LAST_OWNER_REQUIRED");
    const directStatus = await fixture.app.inject({
      method: "PATCH",
      url: `/api/members/${DEMO_IDS.user}/status`,
      headers: bearer(fixture.ownerToken),
      payload: { active: false },
    });
    expect(directStatus.statusCode).toBe(409);
    expect(directStatus.json().error.code).toBe("LAST_OWNER_REQUIRED");

    const invitedOwner = await inviteMember(fixture, { role: "owner", phone: "13900000009", displayName: "第二负责人" });
    expect((await acceptInvitation(fixture.app, invitedOwner.invitation.token, "second-owner-password")).statusCode).toBe(200);
    const secondLogin = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: invitedOwner.member.phone, password: "second-owner-password" },
    });
    expect(secondLogin.statusCode).toBe(200);

    const attempts = await Promise.all([
      fixture.app.inject({
        method: "PATCH",
        url: `/api/members/${DEMO_IDS.user}/role`,
        headers: bearer(fixture.ownerToken),
        payload: { role: "finance" },
      }),
      fixture.app.inject({
        method: "PATCH",
        url: `/api/members/${invitedOwner.member.id}/role`,
        headers: bearer(secondLogin.json().token),
        payload: { role: "finance" },
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(attempts.find((response) => response.statusCode === 409)?.json().error.code).toBe("LAST_OWNER_REQUIRED");
    const owners = await fixture.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memberships
       WHERE tenant_id = $1 AND role = 'owner' AND is_active = true`,
      [DEMO_IDS.tenant],
    );
    expect(Number(owners.rows[0]?.count)).toBe(1);
  });
});
