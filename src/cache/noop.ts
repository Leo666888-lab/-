import { MemoryCache } from "./memory.js";

// Kept for API compatibility. Development still reports the dependency as disabled,
// while retaining correct in-process semantics for expiring one-time values.
export class NoopCache extends MemoryCache {}
