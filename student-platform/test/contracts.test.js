import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationHash, canonicalJSON } from '../src/security.js';
const read = file => JSON.parse(readFileSync(new URL(`../../integration-contracts/${file}`, import.meta.url), 'utf8'));
test('fixed wire example and canonical hash vector agree independently of input key order', () => {
  const p = read('examples/lesson-publication.json'), vector = read('examples/hash-vector.json');
  assert.equal(publicationHash(p), vector.content_hash);
  assert.equal(canonicalJSON(vector.input), vector.canonical_json);
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  assert.equal(publicationHash(reordered), p.content_hash);
});
test('OpenAPI publishes both authentication proofs and the versioned schemas', () => {
  const api = read('openapi.json');
  assert.equal(api.openapi, '3.1.0');
  for (const route of ['teaching-context', 'materials/{publication_id}']) {
    const operation = api.paths[`/integrations/v1/lessons/{lesson_id}/${route}`][route === 'teaching-context' ? 'get' : 'put'];
    assert.deepEqual(operation.security, [{ serviceCredential: [], teacherDelegation: [] }]);
  }
  const schema = read('lesson-publication.v1.schema.json');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.provenance.properties.teacher_reviewed.const, true);
  assert.equal(read('teaching-context.v1.schema.json').properties.schema_version.const, 'teaching-context.v1');
});
