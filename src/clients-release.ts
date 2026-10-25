import { SOURCE_URL } from "./html";

// The TypeScript client, the MCP server, and the Python client are not on npm or PyPI yet
// (issue #80). Until they are, each clients-v* tag builds them and attaches the files, with
// SHA-256 checksums, to a GitHub release. Pages name that release only as an advanced, optional
// install: joining (CT-33) never needs a client. Keep CLIENTS_VERSION equal to the version in
// every client manifest; the release workflow refuses a tag that does not match it.
export const CLIENTS_VERSION = "0.1.0";
export const CLIENTS_TAG = `clients-v${CLIENTS_VERSION}`;
export const CLIENTS_RELEASE_URL = `${SOURCE_URL}/releases/tag/${CLIENTS_TAG}`;

// The release exists only once Danny pushes the tag and the workflow attaches its files. Until
// then the release URL answers 404, so while this is false no page names or links the release
// at all and the plain /join flow stands alone. Flip it to true in a PR after the release is
// live with its assets (docs/RUNBOOK.md).
export const CLIENTS_RELEASE_PUBLISHED: boolean = false;
