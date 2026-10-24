/**
 * Wrangler bundles this package's `browser` build, which swaps the pure-JS XML
 * parser for a `DOMParser`-based one — and workerd has no `DOMParser`.
 *
 * EC2 / RDS / S3 / ELB / VPC / CloudWatch Logs / STS all speak query or REST-XML,
 * so without this alias every one of them fails with
 * `DOMParser is not defined` while JSON services (EKS, Secrets, CE) work fine.
 *
 * Aliased in wrangler.jsonc as `@aws-sdk/xml-builder`.
 */
export { XmlNode } from "@aws-sdk/xml-builder/dist-es/XmlNode.js";
export { XmlText } from "@aws-sdk/xml-builder/dist-es/XmlText.js";
export { parseXML } from "@aws-sdk/xml-builder/dist-es/xml-parser.js";
