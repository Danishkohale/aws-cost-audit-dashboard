/**
 * The SDK ships runtime JS for these subpaths but no adjacent `.d.ts`, so the
 * shim declares the pieces it re-exports. Consumers still see the package's
 * real types (wrangler's alias only affects bundling).
 */
declare module "@aws-sdk/xml-builder/dist-es/xml-parser.js" {
	export function parseXML(xml: string): Record<string, unknown>;
}

declare module "@aws-sdk/xml-builder/dist-es/XmlNode.js" {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export const XmlNode: any;
}

declare module "@aws-sdk/xml-builder/dist-es/XmlText.js" {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export const XmlText: any;
}
