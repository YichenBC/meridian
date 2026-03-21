import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertMarkdownTables } from '../dist/channels/telegram.js';

describe('Telegram table conversion', () => {
  it('converts 2-column tables to key-value pairs', () => {
    const input = `| Setting | Value |
| --- | --- |
| Timeout | 5 min |
| Mode | auto |
| Debug | false |
`;
    const result = convertMarkdownTables(input);
    assert.ok(result.includes('Timeout: 5 min'));
    assert.ok(result.includes('Mode: auto'));
    assert.ok(result.includes('Debug: false'));
    assert.ok(!result.includes('|'));
    assert.ok(!result.includes('---'));
  });

  it('converts 3+ column tables to entry blocks', () => {
    const input = `| Name | Status | Score |
| --- | --- | --- |
| Alice | Pass | 95 |
| Bob | Fail | 40 |
`;
    const result = convertMarkdownTables(input);
    assert.ok(result.includes('Alice'));
    assert.ok(result.includes('Status: Pass'));
    assert.ok(result.includes('Score: 95'));
    assert.ok(result.includes('Bob'));
    assert.ok(!result.includes('|'));
  });

  it('leaves non-table text unchanged', () => {
    const input = 'Hello world\n\n- bullet 1\n- bullet 2\n\n**bold text**';
    assert.equal(convertMarkdownTables(input), input);
  });

  it('handles alignment indicators in separator', () => {
    const input = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |
`;
    const result = convertMarkdownTables(input);
    assert.ok(!result.includes('|'));
    assert.ok(result.includes('Center: b'));
  });

  it('handles tables embedded in longer text', () => {
    const input = `Here are results:

| Key | Value |
| --- | --- |
| Alpha | 1 |
| Beta | 2 |

Text after.`;
    const result = convertMarkdownTables(input);
    assert.ok(result.includes('Alpha: 1'));
    assert.ok(result.includes('Here are results:'));
    assert.ok(result.includes('Text after.'));
  });

  it('handles multiple tables in same text', () => {
    const input = `Table 1:

| A | B |
| --- | --- |
| x | y |

Table 2:

| C | D |
| --- | --- |
| w | z |
`;
    const result = convertMarkdownTables(input);
    assert.ok(result.includes('x: y'), 'First table row 1 should convert');
    assert.ok(result.includes('w: z'), 'Second table row 1 should convert');
  });

  it('preserves bold/italic markdown in cell content', () => {
    const input = `| Feature | Status |
| --- | --- |
| **Core** | Done |
| *Optional* | WIP |
`;
    const result = convertMarkdownTables(input);
    assert.ok(result.includes('**Core**: Done'));
    assert.ok(result.includes('*Optional*: WIP'));
  });
});
