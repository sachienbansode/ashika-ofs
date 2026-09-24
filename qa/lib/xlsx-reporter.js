'use strict';
/**
 * The run, as a workbook.
 *
 * The test plan and the test result are the same document. A hand-maintained list
 * of cases sitting beside an automated suite drifts within weeks and then nobody
 * trusts either; this is generated from the run, so it cannot disagree with what
 * actually executed.
 *
 * One row per case: the id, who it ran as, what it checked, what was expected,
 * what happened, and where the evidence is. A failing run produces the same
 * document with the failures in it rather than no document at all.
 *
 * Case ids come from the test title — "BO-REN-03  Clients tab shows a Branch
 * column" — so the id lives next to the assertion it names, and renaming a test
 * cannot silently renumber the plan.
 */
const path = require('path');
const fs = require('fs');

const ID = /^([A-Z]{2,4}-[A-Z]{2,4}-\d+[a-z]?)\s+(.*)$/;

class XlsxReporter {
  constructor(options) {
    this.out = (options && options.outputFile) || 'results/OFS_Test_Results.xlsx';
    this.rows = [];
    this.started = new Date();
  }

  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.env = process.env.OFS_QA_ENV_NAME || '(unknown)';
    this.base = process.env.OFS_QA_BASE_URL || '';
  }

  onTestEnd(test, result) {
    const m = ID.exec(test.title);
    const file = path.basename(test.location ? test.location.file : '');
    // The project name carries the actor: "desk", "ap", "client".
    const actor = (test.parent && test.parent.project && test.parent.project().name) || '';
    const evidence = (result.attachments || [])
      .filter((a) => a.path && /screenshot|video|trace/.test(a.name))
      .map((a) => path.basename(a.path)).join(' · ');

    this.rows.push({
      id: m ? m[1] : test.title.slice(0, 18),
      group: this.groupOf(m ? m[1] : file, file),
      actor,
      scenario: m ? m[2] : test.title,
      // Playwright carries no "expected" field, so the spec states it in an
      // annotation. A case with no stated expectation is a case nobody can review.
      expected: (test.annotations.find((a) => a.type === 'expected') || {}).description || '',
      result: result.status === 'passed' ? 'PASS'
            : result.status === 'skipped' ? 'SKIP' : 'FAIL',
      detail: result.status === 'passed' ? ''
            : (result.error && String(result.error.message || '').split('\n')[0].slice(0, 300)) || '',
      ms: result.duration,
      evidence,
      file
    });
  }

  groupOf(id, file) {
    const m = /^([A-Z]{2,4}-[A-Z]{2,4})-/.exec(id);
    if (m) return m[1];
    return path.basename(file, '.spec.js');
  }

  async onEnd(result) {
    try {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Ashika OFS QA';
      wb.created = this.started;

      const HEAD = { bold: true, color: { argb: 'FFFFFFFF' } };
      const FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      const pass = this.rows.filter((r) => r.result === 'PASS').length;
      const fail = this.rows.filter((r) => r.result === 'FAIL').length;
      const skip = this.rows.filter((r) => r.result === 'SKIP').length;

      /* ------------------------------------------------------------- summary */
      const s = wb.addWorksheet('Summary');
      s.columns = [{ width: 28 }, { width: 62 }];
      const put = (k, v) => {
        const r = s.addRow([k, v]);
        r.getCell(1).font = { bold: true };
        return r;
      };
      s.addRow(['Ashika OFS — front-end test run']).font = { bold: true, size: 14 };
      s.addRow([]);
      put('Environment', this.env);
      put('Base URL', this.base);
      put('Started', this.started.toISOString());
      put('Finished', new Date().toISOString());
      put('Duration', Math.round((Date.now() - this.started) / 1000) + 's');
      s.addRow([]);
      put('Cases', String(this.rows.length));
      const p = put('Passed', String(pass)); p.getCell(2).font = { bold: true, color: { argb: 'FF067647' } };
      const f = put('Failed', String(fail));
      if (fail) f.getCell(2).font = { bold: true, color: { argb: 'FFB42318' } };
      put('Skipped', String(skip));
      s.addRow([]);
      const v = s.addRow(['Verdict', fail ? 'FAILED' : 'PASSED']);
      v.getCell(1).font = { bold: true };
      v.getCell(2).font = { bold: true, size: 13,
        color: { argb: fail ? 'FFB42318' : 'FF067647' } };

      s.addRow([]);
      const bg = s.addRow(['By group', '']);
      bg.getCell(1).font = { bold: true };
      const groups = [...new Set(this.rows.map((r) => r.group))].sort();
      groups.forEach((g) => {
        const rs = this.rows.filter((r) => r.group === g);
        const bad = rs.filter((r) => r.result === 'FAIL').length;
        s.addRow([g, rs.length + ' case(s) · ' + (rs.length - bad) + ' passed' +
          (bad ? ' · ' + bad + ' FAILED' : '')]);
      });

      /* --------------------------------------------------------- every case */
      const cols = [
        { header: 'ID', key: 'id', width: 16 },
        { header: 'Group', key: 'group', width: 12 },
        { header: 'Actor', key: 'actor', width: 10 },
        { header: 'Scenario', key: 'scenario', width: 62 },
        { header: 'Expected', key: 'expected', width: 54 },
        { header: 'Result', key: 'result', width: 9 },
        { header: 'Detail', key: 'detail', width: 66 },
        { header: 'ms', key: 'ms', width: 8 },
        { header: 'Evidence', key: 'evidence', width: 34 }
      ];
      const write = (ws, rows) => {
        ws.columns = cols;
        const h = ws.getRow(1);
        h.font = HEAD; h.fill = FILL; h.height = 20;
        rows.forEach((r) => {
          const row = ws.addRow(r);
          const c = row.getCell('result');
          if (r.result === 'FAIL') {
            c.font = { bold: true, color: { argb: 'FFB42318' } };
            row.getCell('detail').font = { color: { argb: 'FFB42318' } };
          } else if (r.result === 'PASS') {
            c.font = { color: { argb: 'FF067647' } };
          } else {
            c.font = { color: { argb: 'FF8A6100' } };
          }
        });
        ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
      };

      // Failures first and on their own sheet: on a bad run that is the only
      // sheet anyone opens, and hunting for red rows in four hundred is a way to
      // miss one.
      if (fail) write(wb.addWorksheet('Failures'), this.rows.filter((r) => r.result === 'FAIL'));
      write(wb.addWorksheet('All cases'), this.rows);
      groups.forEach((g) => write(wb.addWorksheet(g.slice(0, 28)), this.rows.filter((r) => r.group === g)));

      fs.mkdirSync(path.dirname(this.out), { recursive: true });
      await wb.xlsx.writeFile(this.out);
      console.log('\nWorkbook: ' + this.out);
      console.log(this.rows.length + ' case(s) — ' + pass + ' passed, ' +
        fail + ' failed, ' + skip + ' skipped');
    } catch (e) {
      // A reporter that throws takes the run's exit code with it, and then a
      // green suite looks red because a spreadsheet could not be written.
      console.error('[xlsx-reporter] could not write the workbook: ' + e.message);
    }
  }
}

module.exports = XlsxReporter;
