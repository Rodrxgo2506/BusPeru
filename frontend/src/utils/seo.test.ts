import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalUrl } from './seo.ts';

describe('F18-19B · URL canónica', () => {
  it('usa el origen en el que se sirve la página (staging no apunta a producción)', () => {
    assert.equal(canonicalUrl('https://d25z2lpl1efut1.cloudfront.net', '/empresas/empresa-a'), 'https://d25z2lpl1efut1.cloudfront.net/empresas/empresa-a');
    assert.equal(canonicalUrl('http://localhost:5173', '/ayuda'), 'http://localhost:5173/ayuda');
  });

  it('normaliza la raíz, las barras finales y las dobles', () => {
    assert.equal(canonicalUrl('https://example.test/', '/'), 'https://example.test/');
    assert.equal(canonicalUrl('https://example.test', ''), 'https://example.test/');
    assert.equal(canonicalUrl('https://example.test', '/empresas/'), 'https://example.test/empresas');
    assert.equal(canonicalUrl('https://example.test', '//empresas//a'), 'https://example.test/empresas/a');
  });
});
