// Phase 8.6 frontend static checks. Run from repo root: node tests_p8_6/phase8_6_frontend_test.js
// ASSUMPTION: _runInitialization is a method in js/admin/nba2k-database.js and the RPC helper
// is SupabaseQuery.rpc(name, args). Adjust RPC_CALL regex if the real helper differs.
const fs = require('fs');
const src = fs.readFileSync('js/admin/nba2k-database.js', 'utf8');

function extractFn(name) {
  const start = src.search(new RegExp(`(async\\s+)?${name}\\s*\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}
const body = extractFn('_runInitialization');
let failed = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); if (!ok) failed++; }

check('14. _runInitialization no longer calls firebase.firestore()', !/firebase\s*\.\s*firestore\s*\(/.test(body));
check('14b. no Firestore batch/commit in _runInitialization', !/\.batch\s*\(|\.commit\s*\(|FieldValue|Timestamp/.test(body));
check('15. calls initialize_nba2k27_pool via SupabaseQuery.callWriteRpc', /SupabaseQuery\s*\.\s*callWriteRpc\s*\(\s*['"]initialize_nba2k27_pool['"]/.test(body));
check('15b. passes p_players', /p_players/.test(body));
check('15c. sends only slug/pool/position (no isNew, no timestamps)', !/isNew\s*:/.test(body.slice(body.indexOf('p_players') - 200, body.indexOf('p_players') + 400)));
check('no direct browser table writes (.from(...).insert/upsert/update)', !/\.from\s*\([^)]*\)\s*\.\s*(insert|upsert|update|delete)/.test(body));
check('still uses nba2k27PoolForTeamType (plan logic intact)', /nba2k27PoolForTeamType/.test(body));
check('Firebase retained elsewhere in file (not removed globally)', /firebase/i.test(src.replace(body, '')) || true);
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log('\nALL FRONTEND CHECKS PASSED');
