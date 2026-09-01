/**
 * Task-facing AD status entry point. The expanded component name keeps its
 * visible accessibility purpose explicit while this stable export preserves
 * the implementation-plan surface for WebMCP and route integration.
 */
export {
  AudioDescriptionGenerationStatus as AdGenerationStatus,
  type AudioDescriptionGenerationStatusProps as AdGenerationStatusProps,
} from "./AudioDescriptionGenerationStatus";
