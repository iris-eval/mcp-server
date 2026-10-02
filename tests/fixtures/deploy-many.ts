/*
 * One process deploying `count` rules to a shared rules file, as fast as it
 * can. tests/unit/custom-rule-store-shared.test.ts starts several of these
 * at once and counts what the file holds afterwards.
 *
 *   node --import tsx tests/fixtures/deploy-many.ts <rules.json> <audit.log> <prefix> <count>
 */
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const [rulesPath, auditPath, prefix, count] = process.argv.slice(2);
const store = createCustomRuleStore({ pathFor: () => rulesPath, auditPath });
for (let i = 0; i < Number(count); i++) {
  store.deploy(LOCAL_TENANT, {
    name: `${prefix}-${i}`,
    evalType: 'custom',
    severity: 'low',
    definition: { name: `${prefix}-${i}`, type: 'regex_no_match', config: { pattern: `${prefix}${i}` } },
    user: prefix,
  });
}
