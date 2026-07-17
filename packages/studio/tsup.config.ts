import { createPackageConfig } from "../../tooling/tsup-preset";

export default createPackageConfig({
  platform: "browser",
  target: "es2022"
});
