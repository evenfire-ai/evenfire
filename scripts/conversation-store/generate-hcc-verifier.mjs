import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// One reviewed source feeds both the standalone operator program and trusted
// HCC stdin execution. The contract test rejects drift between the two.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "scripts/conversation-store/verify-inline.mjs"), "utf8");
const output = "// Generated from scripts/conversation-store/verify-inline.mjs; contract tests verify exact bytes.\n" +
  "// HCC executes this source through authenticated Exec, never a tenant-writable file.\n" +
  "export const CONVERSATION_STORE_BOOTSTRAP_VERIFY_PROGRAM = [\n" +
  source.split(/(?<=\n)/).filter(Boolean).map(line => "  " + JSON.stringify(line) + ",\n").join("") +
  "].join('')\n";
fs.writeFileSync(path.join(root, "host-context-controller/src/conversationStoreBootstrapProgram.ts"), output);
process.stdout.write("HCC_VERIFIER_GENERATED\n");
