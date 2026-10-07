#!/usr/bin/env node
/**
 * Moderation from the terminal.
 *
 *   SUBMISSIONS_API=https://<worker>.workers.dev ADMIN_TOKEN=... node scripts/moderate.mjs <command>
 *
 *   list [held|published|rejected|all]     default: held
 *   show <id>
 *   publish <id> [note]                    held -> on the map
 *   reject <id> [note]                     off the map
 *   edit <id> <field>=<value>... [--publish]
 *   delete <id>                            gone for good (e.g. a removal request)
 *
 *   edits [pending|all]                    edits of jdn restaurants, default: pending
 *   accept <edit-id> [field...]            accept all (or the named) undecided fields
 *   decline <edit-id> [field...]
 *   versions                               our corrections to jdn listings (their shadows)
 *   sync                                   bring shadows into step with jdn now (also nightly)
 *   rebuild [--wait]                       rebuild and publish the map now instead of at
 *                                          03:00 UTC (GitHub's `gh` CLI; no admin token)
 *   unversion <restaurant> [field]         drop our value(s); jdn's show again
 *   correct <jdn-id> field=value...        correct a jdn listing yourself (into its shadow)
 *
 *   reports [open|resolved|dismissed|all]  default: open
 *   resolve <report-id> [note]
 *   dismiss <report-id> [note]
 */

import { execFileSync } from 'node:child_process';

const API = (process.env.SUBMISSIONS_API || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN;
const REPO = process.env.MAP_REPO || 'clippycoder/kosher-restaurant-map';

async function api(method, path, body) {
  if (!TOKEN) {
    console.error('ADMIN_TOKEN is not set');
    process.exit(2);
  }
  const res = await fetch(`${API}/api/admin/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${res.status} ${JSON.stringify(out)}`);
    process.exit(1);
  }
  return out;
}

const flagText = (f) => (f.kind === 'duplicate'
  ? `duplicate of ${f.source} ${f.id} "${f.name}" (${f.reason})`
  : `${f.reason} in ${f.field}`);

function printSubmission(s, full = false) {
  const d = s.data;
  const what = s.shadows ? ` (shadow of jdn ${s.shadows})` : '';
  console.log(`#${s.id} [${s.status}]${what} ${d.name} — ${d.address}, ${d.city} · ` +
    [d.type, d.hechsher, d.phone].filter(Boolean).join(' · '));
  for (const f of s.flags) console.log(`    ! ${flagText(f)}`);
  if (!full) return;
  for (const [k, v] of Object.entries(d)) console.log(`    ${k}: ${v}`);
  for (const [k, v] of Object.entries(s.private)) console.log(`    (private) ${k}: ${v}`);
  console.log(`    submitted ${s.createdAt}${s.reviewedAt ? `, reviewed ${s.reviewedAt}` : ''}` +
    `${s.reviewNote ? ` — ${s.reviewNote}` : ''}`);
}

const [cmd, ...args] = process.argv.slice(2);
const id = () => {
  if (!/^\d+$/.test(args[0] || '')) {
    console.error('needs a numeric id');
    process.exit(2);
  }
  return args[0];
};
const note = () => args.slice(1).join(' ') || undefined;

switch (cmd) {
  case 'list': {
    const { submissions } = await api('GET', `submissions?status=${args[0] || 'held'}&limit=200`);
    if (!submissions.length) console.log('nothing here');
    submissions.forEach((s) => printSubmission(s));
    break;
  }
  case 'show':
    printSubmission(await api('GET', `submissions/${id()}`), true);
    break;
  case 'publish':
  case 'reject':
    printSubmission(await api('POST', `submissions/${id()}`, { action: cmd, note: note() }));
    break;
  case 'edit': {
    const n = id();
    const publish = args.includes('--publish');
    const edits = Object.fromEntries(args.slice(1).filter((a) => a.includes('='))
      .map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const current = await api('GET', `submissions/${n}`);
    const action = publish ? 'publish' : { published: 'publish', held: 'reject', rejected: 'reject' }[current.status];
    if (!publish && current.status === 'held') {
      console.error('a held entry is published or rejected when edited; add --publish to publish it');
      process.exit(2);
    }
    printSubmission(await api('POST', `submissions/${n}`, { action, edits, note: 'edited' }), true);
    break;
  }
  case 'delete':
    console.log(await api('DELETE', `submissions/${id()}`));
    break;
  case 'edits': {
    const { edits } = await api('GET', `edits?status=${args[0] || 'pending'}&limit=200`);
    if (!edits.length) console.log('nothing here');
    for (const e of edits) {
      console.log(`#${e.id} restaurant ${e.restaurant} (${e.createdAt})`);
      for (const f of e.flags) console.log(`    ! ${flagText(f)}`);
      for (const f of e.fields) {
        console.log(`    ${f.field}: "${f.base}" -> "${f.value}" [${f.status}${f.decidedBy ? `, ${f.decidedBy}` : ''}]`);
      }
      for (const [k, v] of Object.entries(e.private)) console.log(`    (private) ${k}: ${v}`);
    }
    break;
  }
  case 'accept':
  case 'decline': {
    const fields = args.slice(1);
    const e = await api('POST', `edits/${id()}`, {
      action: cmd === 'accept' ? 'accept' : 'reject',
      ...(fields.length ? { fields } : {}),
    });
    for (const f of e.fields) console.log(`#${e.id} ${f.field}: ${f.status}`);
    break;
  }
  case 'versions': {
    const { versions } = await api('GET', 'versions');
    if (!versions.length) console.log('nothing here');
    for (const v of versions) {
      console.log(`jdn ${v.restaurant} (shadow ${v.shadow}, ${v.status}) ${v.field}: ` +
        `"${v.base}" -> "${v.value}" (${v.accepted_at})`);
    }
    break;
  }
  case 'correct': {
    if (!/^\d+$/.test(args[0] || '')) {
      console.error('needs a jdn listing id');
      process.exit(2);
    }
    const fields = Object.fromEntries(args.slice(1).filter((a) => a.includes('='))
      .map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const r = await api('POST', `versions/${args[0]}`, fields);
    console.log(`jdn ${r.restaurant}: ${r.applied.length ? `corrected ${r.applied.join(', ')}` : 'nothing changed'}`);
    break;
  }
  case 'rebuild': {
    // The daily data job, run now: it pulls published listings and corrections,
    // rebuilds the map's data and publishes the site.
    const gh = (...a) => execFileSync('gh', [...a, '--repo', REPO], { encoding: 'utf8' });
    const latest = () => JSON.parse(gh('run', 'list', '--workflow', 'build.yml', '--limit', '1',
      '--json', 'databaseId,status,conclusion,createdAt'))[0];
    const before = latest()?.databaseId;
    try {
      gh('workflow', 'run', 'build.yml');
    } catch (err) {
      console.error(`could not start the rebuild (is \`gh\` installed and logged in?)\n${err.stderr || err.message}`);
      process.exit(1);
    }
    console.log('Rebuild started. The map updates in about 1-5 minutes.');
    if (!args.includes('--wait')) break;

    let run;
    for (let i = 0; i < 30 && !(run && run.databaseId !== before); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      run = latest();
    }
    if (!run || run.databaseId === before) {
      console.error('the run did not appear; check the Actions tab');
      process.exit(1);
    }
    console.log(`Watching https://github.com/${REPO}/actions/runs/${run.databaseId} ...`);
    try {
      execFileSync('gh', ['run', 'watch', String(run.databaseId), '--exit-status', '--repo', REPO], { stdio: 'ignore' });
      console.log('Rebuilt; the site is publishing now and is live within a minute or two.');
    } catch {
      console.error(`The rebuild failed: https://github.com/${REPO}/actions/runs/${run.databaseId}`);
      process.exit(1);
    }
    break;
  }
  case 'sync':
    console.log(await api('POST', 'sync'));
    break;
  case 'unversion': {
    if (!/^\d+$/.test(args[0] || '')) {
      console.error('needs a restaurant id');
      process.exit(2);
    }
    console.log(await api('DELETE', `versions/${args[0]}${args[1] ? `/${args[1]}` : ''}`));
    break;
  }
  case 'reports': {
    const { reports } = await api('GET', `reports?status=${args[0] || 'open'}&limit=200`);
    if (!reports.length) console.log('nothing here');
    for (const r of reports) {
      console.log(`#${r.id} [${r.status}] restaurant ${r.restaurant}: ${r.kind}` +
        `${r.details ? ` — ${r.details}` : ''} (${r.createdAt})`);
    }
    break;
  }
  case 'resolve':
  case 'dismiss': {
    const r = await api('POST', `reports/${id()}`, { action: cmd, note: note() });
    console.log(`#${r.id} -> ${r.status}`);
    break;
  }
  default:
    console.log('commands: list, show, publish, reject, edit, delete, edits, accept, decline, ' +
      'versions, unversion, correct, sync, rebuild, reports, resolve, dismiss');
    process.exit(cmd ? 2 : 0);
}
