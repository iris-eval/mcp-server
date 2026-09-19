/*
 * A judge from the agent's own model family is not an independent reader
 * (arc 7, D-6b). The family is read from the id's leading token, provider
 * prefixes stripped; unknown ids are never "same"; a trace records the
 * agent's model under metadata.model or a span's gen_ai attributes.
 */
import { describe, expect, it } from 'vitest';
import { agentModelOf, modelFamily, sameFamily, sameFamilyWarning } from '../../../../src/eval/llm-judge/family.js';

describe('modelFamily', () => {
  it('reads the lineage off the id, with a provider prefix stripped', () => {
    expect(modelFamily('claude-haiku-4-5')).toBe('claude');
    expect(modelFamily('claude-opus-4-7')).toBe('claude');
    expect(modelFamily('anthropic/claude-sonnet-4-6')).toBe('claude');
    expect(modelFamily('us.anthropic.claude-sonnet-4-6-v1:0')).toBe('claude');
    expect(modelFamily('gpt-4o-mini')).toBe('gpt');
    expect(modelFamily('openai:gpt-4.1')).toBe('gpt');
    expect(modelFamily('chatgpt-4o-latest')).toBe('gpt');
    expect(modelFamily('o1-mini')).toBe('o-series');
    expect(modelFamily('o3')).toBe('o-series');
    expect(modelFamily('models/gemini-2.5-pro')).toBe('gemini');
    expect(modelFamily('meta-llama/Llama-3.3-70B-Instruct')).toBe('llama');
    expect(modelFamily('mixtral-8x22b')).toBe('mistral');
  });

  it('says nothing about an id it does not recognise, and never calls two unknowns the same', () => {
    expect(modelFamily('my-fine-tune-v2')).toBeNull();
    expect(modelFamily('')).toBeNull();
    expect(modelFamily(undefined)).toBeNull();
    expect(sameFamily('my-fine-tune-v2', 'my-fine-tune-v2')).toBe(false);
  });

  it('the o-series is not the gpt family: the shared letter is not a shared lineage', () => {
    expect(sameFamily('gpt-4o', 'o1-mini')).toBe(false);
    expect(sameFamily('gpt-4o', 'gpt-4o-mini')).toBe(true);
    expect(sameFamily('claude-haiku-4-5', 'claude-opus-4-7')).toBe(true);
    expect(sameFamily('claude-haiku-4-5', 'gpt-4o')).toBe(false);
  });
});

describe('agentModelOf', () => {
  it('reads metadata.model first, then a span attribute, and null when nothing recorded it', () => {
    expect(agentModelOf({ metadata: { model: 'gpt-4o' }, spans: [{ attributes: { 'gen_ai.request.model': 'claude-haiku-4-5' } }] })).toBe('gpt-4o');
    expect(agentModelOf({ spans: [{ attributes: { temperature: 0 } }, { attributes: { 'gen_ai.request.model': 'claude-haiku-4-5' } }] })).toBe('claude-haiku-4-5');
    expect(agentModelOf({ metadata: { model: 42 } })).toBeNull();
    expect(agentModelOf({})).toBeNull();
  });
});

describe('sameFamilyWarning', () => {
  it('names both models and the family, and says the evaluation stands', () => {
    const w = sameFamilyWarning('claude-haiku-4-5', 'claude-opus-4-7');
    expect(w.code).toBe('IRIS_JUDGE_SAME_FAMILY');
    expect(w.message).toContain('claude-haiku-4-5');
    expect(w.message).toContain('claude-opus-4-7');
    expect(w.message).toContain('(claude)');
    expect(w.message).toMatch(/stands/);
  });
});
