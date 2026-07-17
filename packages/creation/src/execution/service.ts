import {
  routegoEditInputSchema,
  routegoGenerateInputSchema
} from "@routego-image/contracts";

import { createResolvedImageExecutor } from "./executor";
import type { CreationImageService, ImageExecutionDependencies } from "./types";

export function createCreationImageService(
  dependencies: ImageExecutionDependencies
): CreationImageService {
  const executor = createResolvedImageExecutor(dependencies);
  return {
    generate(input) {
      return executor.execute(routegoGenerateInputSchema.parse(input));
    },
    edit(input) {
      return executor.execute(routegoEditInputSchema.parse(input));
    }
  };
}
