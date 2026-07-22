import { routegoGenerateInputSchema } from "@routego-image/contracts";

import { createBatchExecutor, type CreationBatchService } from "./batch";
import { createResolvedImageExecutor } from "./executor";
import type { CreationImageService, ImageExecutionDependencies } from "./types";

export function createCreationImageService(
  dependencies: ImageExecutionDependencies
): CreationImageService & CreationBatchService {
  const executor = createResolvedImageExecutor(dependencies);
  const batch = createBatchExecutor({ executor });
  return {
    generate(input) {
      return executor.execute(routegoGenerateInputSchema.parse(input));
    },
    batch(input) {
      return batch.execute(input);
    }
  };
}
