import { describe, expect, it } from 'vitest';
import { createOriginalAiCandidateSnapshot, readOriginalAiCandidateSnapshot } from './sourcingAiCandidateSnapshot.js';

describe('original AI candidate snapshots', () => {
  it('persists only bounded structured quote fields and excludes evidence text', () => {
    const sourceCandidate = {
      itemKey: 'item-1',
      inquiryItemId: 'inquiry-item-1',
      partNumber: 'PN-1',
      quantity: 2,
      quantityUnit: 'EA',
      unitPrice: 100,
      currency: 'USD',
      leadTimeDays: 5,
      leadTimeMinDays: null,
      leadTimeMaxDays: null,
      validUntil: '2026-12-31',
      taxIncluded: true,
      freightIncluded: false,
      incoterm: 'fca',
      evidenceText: 'Private supplier email content',
      condition: 'A long freeform condition',
    };
    const snapshot = createOriginalAiCandidateSnapshot([sourceCandidate]);

    expect(snapshot).toEqual({
      schemaVersion: 1,
      candidateCount: 1,
      truncated: false,
      items: [{
        itemKey: 'item-1',
        inquiryItemId: 'inquiry-item-1',
        partNumber: 'PN-1',
        quantity: 2,
        quantityUnit: 'EA',
        unitPrice: 100,
        currency: 'USD',
        leadTimeDays: 5,
        leadTimeMinDays: null,
        leadTimeMaxDays: null,
        validUntil: '2026-12-31',
        taxIncluded: true,
        freightIncluded: false,
        incoterm: 'FCA',
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('Private supplier email content');
    expect(JSON.stringify(snapshot)).not.toContain('A long freeform condition');
  });

  it('caps the candidate array and marks truncated snapshots', () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      itemKey: `item-${index}`,
      partNumber: `PN-${index}`,
      quantity: 1,
    }));

    const snapshot = createOriginalAiCandidateSnapshot(candidates);

    expect(snapshot.candidateCount).toBe(100);
    expect(snapshot.items).toHaveLength(100);
    expect(snapshot.truncated).toBe(true);
  });

  it('rejects unavailable and malformed persisted snapshots without exposing unknown fields', () => {
    expect(readOriginalAiCandidateSnapshot(undefined)).toBeNull();
    expect(readOriginalAiCandidateSnapshot({
      schemaVersion: 1,
      candidateCount: 1,
      truncated: false,
      items: [{ partNumber: 'PN-1', evidenceText: 'private', unitPrice: 25 }],
    })).toEqual({
      schemaVersion: 1,
      candidateCount: 1,
      truncated: false,
      items: [{
        itemKey: null,
        inquiryItemId: null,
        partNumber: 'PN-1',
        quantity: null,
        quantityUnit: null,
        unitPrice: 25,
        currency: null,
        leadTimeDays: null,
        leadTimeMinDays: null,
        leadTimeMaxDays: null,
        validUntil: null,
        taxIncluded: null,
        freightIncluded: null,
        incoterm: null,
      }],
    });
    expect(readOriginalAiCandidateSnapshot({
      schemaVersion: 1,
      candidateCount: 1,
      items: [{ partNumber: 'vendor@example.test' }],
    })?.items[0].partNumber).toBeNull();
  });
});
