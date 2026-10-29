import { LocalTransport, type ExecOptions } from "#framework/runtime/transport/transport.ts";
import { fixtureMutationTarget } from "./fixture-mutation.ts";

export class ShimTransport extends LocalTransport {
  readonly root: string;
  readonly shim: string;
  readonly branch: string;
  constructor(root: string, shim: string, branch: string) {
    super(); this.root = root; this.shim = shim; this.branch = branch;
  }
  override async mkdirp(path: string) { return super.mkdirp(await fixtureMutationTarget(this.root, path)); }
  override async writeFile(path: string, content: string | Uint8Array, mode?: string) {
    return super.writeFile(await fixtureMutationTarget(this.root, path), content, mode);
  }
  override async remove(path: string) { return super.remove(await fixtureMutationTarget(this.root, path)); }
  override exec(command: string, args: string[], options: ExecOptions = {}) {
    return super.exec(process.execPath, [this.shim, this.root, this.branch, command, ...args], options);
  }
}
