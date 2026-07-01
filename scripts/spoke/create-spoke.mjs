import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/spoke -> scripts -> sjf_catalog -> sjf_catalog -> coding_workspaces
const WORKSPACES_DIR = path.resolve(__dirname, '../../../..');
const CDI_FACTORY_DIR = path.join(WORKSPACES_DIR, 'cdi-factory');
const CCSJ_CATALOG_DIR = path.join(WORKSPACES_DIR, 'ccsj-catalog');
const TARGET_MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

const args = process.argv.slice(2);
const phaseArg = args.find(a => a.startsWith('--phase=') || a === '--phase');
const phase = phaseArg === '--phase' ? args[args.indexOf('--phase') + 1] : phaseArg?.split('=')[1];

if (phase !== 'schema') {
  console.log(`Phase '${phase}' not fully implemented. Only --phase schema is supported right now.`);
  process.exit(0);
}

console.log('==> Starting Phase: schema');

if (fs.existsSync(TARGET_MIGRATIONS_DIR)) {
  fs.rmSync(TARGET_MIGRATIONS_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TARGET_MIGRATIONS_DIR, { recursive: true });

const cdiMigrationsDir = path.join(CDI_FACTORY_DIR, 'supabase/migrations');
if (!fs.existsSync(cdiMigrationsDir)) {
  console.error(`ERROR: Cannot find cdi-factory migrations at ${cdiMigrationsDir}`);
  process.exit(1);
}

const cdiFiles = fs.readdirSync(cdiMigrationsDir).filter(f => f.endsWith('.sql'));
for (const file of cdiFiles) {
  if (file.includes('resize_embedding_to_1024')) {
    console.log(`Skipping: ${file} (Delta #1)`);
    continue;
  }
  
  let content = fs.readFileSync(path.join(cdiMigrationsDir, file), 'utf-8');
  console.log(`Processing Hub migration: ${file}`);
  
  // Delta #3: Strip app.current_tenant references
  const policyRegex = /CREATE POLICY[^;]+app\.current_tenant[^;]+;/gi;
  content = content.replace(policyRegex, '-- Dropped tenant isolation policy for spoke');
  
  fs.writeFileSync(path.join(TARGET_MIGRATIONS_DIR, file), content);
}

const ccsjMigrationsDir = path.join(CCSJ_CATALOG_DIR, 'supabase/migrations');
const ccsjAllowList = [
  'rls_policies',
  'improvement_plans',
  'relationship_tables_rls',
  'corrections_target_row_id_nullable',
  'corrections_apply_audit_columns',
  'documents_catalog_pdf_url',
  'embedding_1536_hnsw',
  'documents_presentation_overrides',
  'catalog_agent_usage'
];

if (fs.existsSync(ccsjMigrationsDir)) {
  const ccsjFiles = fs.readdirSync(ccsjMigrationsDir).filter(f => f.endsWith('.sql'));
  for (const file of ccsjFiles) {
    if (file.includes('accreditor') || file.includes('accreditation')) {
      console.log(`Skipping: ${file} (Delta #2)`);
      continue;
    }
    
    const isAllowed = ccsjAllowList.some(allowed => file.includes(allowed));
    if (isAllowed) {
      console.log(`Processing CCSJ migration: ${file}`);
      
      let content = fs.readFileSync(path.join(ccsjMigrationsDir, file), 'utf-8');
      
      fs.writeFileSync(path.join(TARGET_MIGRATIONS_DIR, file), content);
    }
  }
} else {
  console.warn(`WARNING: Cannot find ccsj-catalog migrations at ${ccsjMigrationsDir}`);
}

console.log('==> Schema assembly complete.');
console.log('==> You can now run `npx supabase db push` against the project.');
