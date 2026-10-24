/**
 * The frontend Worker only serves the React SPA.
 * All API calls go to the backend (Render) directly from the browser,
 * so this handler simply delegates to the static assets binding,
 * which also takes care of the single-page-application fallback.
 */
export default {
	async fetch(request, env) {
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<{ ASSETS: Fetcher }>;
