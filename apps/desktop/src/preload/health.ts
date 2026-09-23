import type { RendererFailure } from "../main/supervisor.js";
import type { SupervisedState } from "../main/supervisor.js";

export interface RuntimeHealth {
  worker: SupervisedState;
  workerRestarts: number;
  commandsInFlight: number;
  rendererFailure: RendererFailure | null;
}
