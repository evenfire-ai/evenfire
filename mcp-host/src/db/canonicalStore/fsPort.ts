import * as fs from 'node:fs'

/** The production filesystem boundary also provides deterministic crash injection. */
export type FsPort = Pick<
  typeof fs,
  | 'mkdirSync'
  | 'writeFileSync'
  | 'renameSync'
  | 'copyFileSync'
  | 'openSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'rmSync'
  | 'statfsSync'
  | 'readSync'
>
export const nodeFs: FsPort = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  readSync: fs.readSync,
  rmSync: fs.rmSync,
  statfsSync: fs.statfsSync,
}
