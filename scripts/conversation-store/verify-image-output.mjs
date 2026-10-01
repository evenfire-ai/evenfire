import * as fs from "node:fs";
const file = process.argv[2];
try {
  const proof = JSON.parse(fs.readFileSync(file, "utf8").trim());
  const expected = [
    "sqlite-load",
    "compiled-cli",
    "floor-migration",
    "floor-boot-check",
    "floor-catalog",
    "compiled-boot-check",
    "full-catalog",
    "worker-start",
    "writer-fence",
    "worker-close",
    "post-cutover-write",
    "stable-boot",
  ];
  if (
    proof.proofVersion !== 1 ||
    proof.outcome !== "ok" ||
    proof.uid !== 1001 ||
    proof.gid !== 1001 ||
    !/^v24\./.test(proof.nodeVersion ?? "") ||
    proof.sessions !== 3 ||
    proof.messagesBefore !== 5 ||
    proof.messagesAfter !== 6 ||
    proof.approvals !== 1 ||
    !/^([0-9a-f]{64})$/.test(proof.sourceCatalogHash ?? "") ||
    proof.sourceCatalogHash !== proof.preservedCatalogHash ||
    proof.sourceCatalogHash !== proof.floorCatalogHash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.floorMigrationId ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      proof.storeId ?? "",
    ) ||
    !Array.isArray(proof.checks) ||
    expected.some((check) => !proof.checks.includes(check))
  )
    throw new Error("ImageProofIncomplete");
  process.stdout.write("IMAGE_CAPABILITY_VERIFIED\n");
} catch {
  process.stderr.write("IMAGE_PROOF_INVALID\n");
  process.exitCode = 1;
}
