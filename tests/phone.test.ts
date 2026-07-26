import { expect, it } from "vitest";
import { normalizePhone, phoneForAliyun } from "../src/lib/phone.js";

it.each([
  ["13800000000", "13800000000"],
  ["+86 138 0000 0000", "13800000000"],
  ["0086-13900000000", "13900000000"],
  ["86 (137) 0000-0000", "13700000000"],
  ["+971501234567", "+971501234567"],
])("normalizes mainland and E.164 phone numbers", (input, expected) => {
  expect(normalizePhone(input)).toBe(expected);
});

it.each(["", "12345", "+00123456789", "12800000000", "+86-not-a-phone", "138000000000"])(
  "rejects invalid SMS phone numbers",
  (input) => expect(normalizePhone(input)).toBeNull(),
);

it("formats domestic and international destinations for Aliyun", () => {
  expect(phoneForAliyun("+86 13800000000")).toBe("13800000000");
  expect(phoneForAliyun("+971501234567")).toBe("971501234567");
});
