// SPDX-License-Identifier: MIT
// Shared catalog-schema conformance checks for c3 (mirrors c2 catalog.test.mjs coverage).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_SCHEMA_VERSION, inferSourceClass, withCatalogMetadata } from './embed.mjs';

const REQUIRED = [
    'id', 'platform', 'kind', 'name', 'description', 'source', 'availability', 'packaging',
    'domain', 'execution', 'sourceClass', 'license', 'maturity', 'surface', 'parentPlugin', 'permissions',
];

test('schema version matches the shared contract', () => {
    assert.equal(CATALOG_SCHEMA_VERSION, 3);
});

test('availability and packaging stay independent; distribution is stripped', () => {
    const fromPackaging = withCatalogMetadata({
        kind: 'plugin', name: 'demo', description: '', source: 'anthropics/claude-plugins-official',
        distribution: 'plugin',
    });
    assert.equal(fromPackaging.availability, 'installable');
    assert.equal(fromPackaging.packaging, 'plugin');
    assert.equal('distribution' in fromPackaging, false);

    const fromAvailability = withCatalogMetadata({
        kind: 'skill', name: 'demo', description: '', source: 'installed',
        distribution: 'installed',
    });
    assert.equal(fromAvailability.availability, 'installed');
    assert.equal(fromAvailability.packaging, 'unknown');
    assert.equal('distribution' in fromAvailability, false);

    const explicit = withCatalogMetadata({
        kind: 'monitor', name: 'demo', description: '', source: 'claude-code plugin API',
        availability: 'authoring-required', packaging: 'plugin-component', execution: 'background',
    });
    assert.equal(explicit.availability, 'authoring-required');
    assert.equal(explicit.packaging, 'plugin-component');
    assert.equal(explicit.execution, 'background-monitor');
});

test('normalized entries expose the shared required fields', () => {
    const entry = withCatalogMetadata({
        kind: 'skill', name: 'Example', description: 'demo', source: 'installed',
        availability: 'installed', packaging: 'standalone', execution: 'prompt',
    });
    for (const field of REQUIRED) assert.ok(field in entry, `missing ${field}`);
    assert.equal(entry.id, 'skill:Example');
    assert.equal(entry.platform, 'claude-code');
    assert.equal(entry.sourceClass, 'unknown');
});

test('only known publisher sources receive a provenance classification', () => {
    assert.equal(inferSourceClass('anthropics/claude-plugins-official'), 'official');
    assert.equal(inferSourceClass('aitmpl.com'), 'community');
    assert.equal(inferSourceClass('registry.modelcontextprotocol.io'), 'unknown');
});

test('MCP install strings must not embed registry server names', () => {
    const evil = 'evil`rm -rf /`';
    const install = `claude mcp add <任意の名前> --url https://example.com`;
    assert.equal(install.includes(evil), false);
    assert.match(install, /<任意の名前>/);
});
