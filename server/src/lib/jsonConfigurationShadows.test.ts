import { describe, expect, it } from 'vitest';
import {
  buildJsonArrayShadow,
  buildJsonObjectShadow,
  preferredJsonArray,
  preferredJsonObject,
  reconcileJsonConfigurationShadows,
} from './jsonConfigurationShadows.js';

describe('JSON configuration shadows', () => {
  it('dual-write helpers retain legacy JSON text and structured values', () => {
    expect(buildJsonObjectShadow({ Authorization: 'Bearer token' })).toEqual({
      legacy: '{"Authorization":"Bearer token"}',
      shadow: { Authorization: 'Bearer token' },
    });
    expect(buildJsonArrayShadow(['read', 'write'])).toEqual({
      legacy: '["read","write"]',
      shadow: ['read', 'write'],
    });
  });

  it('prefers a valid JSON shadow while retaining a legacy fallback', () => {
    expect(preferredJsonObject({ retry: 3 }, '{"retry":1}')).toEqual({ retry: 3 });
    expect(preferredJsonArray(null, '["read"]')).toEqual(['read']);
  });

  it('reconciles equivalent JSON regardless of object-key order', () => {
    const result = reconcileJsonConfigurationShadows([
      {
        entity: 'webhookEndpoint',
        id: 'endpoint-1',
        field: 'customHeaders',
        shape: 'object',
        legacyValue: '{"X-Trace":"trace-1","Authorization":"Bearer token"}',
        shadowValue: { Authorization: 'Bearer token', 'X-Trace': 'trace-1' },
      },
      {
        entity: 'apiKey',
        id: 'key-1',
        field: 'scopes',
        shape: 'array',
        legacyValue: '["read","write"]',
        shadowValue: ['read', 'write'],
      },
    ]);

    expect(result).toMatchObject({
      status: 'PASS',
      checkedValues: 2,
      missingShadows: 0,
      invalidLegacyJson: 0,
      invalidShadowJson: 0,
      mismatchedValues: 0,
      issues: [],
    });
  });

  it('reports missing, malformed, invalid-shape, and divergent values', () => {
    const result = reconcileJsonConfigurationShadows([
      {
        entity: 'webhookEndpoint',
        id: 'endpoint-1',
        field: 'customHeaders',
        shape: 'object',
        legacyValue: '{}',
        shadowValue: null,
      },
      {
        entity: 'webhookSubscription',
        id: 'subscription-1',
        field: 'eventTypes',
        shape: 'array',
        legacyValue: 'not-json',
        shadowValue: [],
      },
      {
        entity: 'workflowAction',
        id: 'action-1',
        field: 'payload',
        shape: 'object',
        legacyValue: '{}',
        shadowValue: [],
      },
      {
        entity: 'apiKey',
        id: 'key-1',
        field: 'scopes',
        shape: 'array',
        legacyValue: '["read"]',
        shadowValue: ['admin'],
      },
    ]);

    expect(result).toMatchObject({
      status: 'FAIL',
      missingShadows: 1,
      invalidLegacyJson: 1,
      invalidShadowJson: 1,
      mismatchedValues: 1,
    });
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      'MISSING_SHADOW',
      'INVALID_LEGACY_JSON',
      'INVALID_SHADOW_JSON',
      'MISMATCH',
    ]);
  });
});
