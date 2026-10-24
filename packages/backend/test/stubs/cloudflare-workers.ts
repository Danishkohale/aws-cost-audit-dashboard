/**
 * Minimal `cloudflare:workers` stub for the Node-based Vitest run.
 *
 * The production Worker gets the real `DurableObject` base class from workerd.
 * Node has no such module, and importing `src/index.ts` pulls in `CredsVault`
 * (which extends it), so the alias in `vitest.config.ts` points here instead.
 *
 * Nothing in these tests instantiates `CredsVault`; the class only needs to be
 * constructible so `extends` resolves.
 */
export class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState;
	protected env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
