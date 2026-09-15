'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { csvParse, csvObjects, csvNum } = require('../public/backoffice/csv');

test('parses quoted fields, embedded commas and doubled quotes', () => {
  const rows = csvParse('a,b,c\r\n1,"x,y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', 'he said "hi"']]);
});

test('handles LF, CRLF, a trailing newline and a BOM', () => {
  assert.equal(csvParse('a,b\n1,2').length, 2);
  assert.equal(csvParse('a,b\r\n1,2\r\n').length, 2);
  assert.equal(csvParse('﻿a,b\n1,2')[0][0], 'a');
});

test('drops blank lines but keeps rows with empty cells', () => {
  const rows = csvParse('a,b\n\n1,\n\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '']]);
});

test('keeps a newline inside a quoted field', () => {
  assert.deepEqual(csvParse('a,b\n"line1\nline2",2'), [['a', 'b'], ['line1\nline2', '2']]);
});

test('csvObjects normalises headers and trims values', () => {
  const objs = csvObjects(csvParse('Client UCC,Available Margin\r\n ASH1001 , 250000 \r\n'));
  assert.deepEqual(objs, [{ client_ucc: 'ASH1001', available_margin: '250000' }]);
});

test('csvObjects fills missing trailing cells with empty strings', () => {
  assert.deepEqual(csvObjects(csvParse('a,b,c\n1,2')), [{ a: '1', b: '2', c: '' }]);
});

test('an empty input yields no rows', () => {
  assert.deepEqual(csvParse(''), []);
  assert.deepEqual(csvObjects([]), []);
});

/* csvNum — a margin file as a spreadsheet actually writes it.
 *
 * Every one of these was previously NaN, so the row was rejected with
 * “available must be a number >= 0” and the desk was told the upload failed on
 * a file that was correct. */
test('csvNum reads Indian digit grouping, a rupee sign and Excel spacing', () => {
  assert.equal(csvNum('12,50,000'), 1250000);
  assert.equal(csvNum('₹ 1,00,000.50'), 100000.5);
  assert.equal(csvNum('INR 2,00,000'), 200000);
  assert.equal(csvNum('  7,500  '), 7500);
});

test('csvNum reads an accountancy negative', () => {
  assert.equal(csvNum('(1,234)'), -1234);
  assert.equal(csvNum('-2500'), -2500);
});

test('csvNum still refuses what is genuinely not a number', () => {
  for (const bad of ['', '   ', 'abc', '12-34', '1,2,3.4.5', 'N/A', '--5']) {
    assert.ok(Number.isNaN(csvNum(bad)), bad + ' should be NaN');
  }
});

test('csvNum leaves plain numbers alone', () => {
  assert.equal(csvNum('0'), 0);
  assert.equal(csvNum('5000'), 5000);
  assert.equal(csvNum(4200), 4200);
  assert.equal(csvNum('1e3'), 1000);
});
