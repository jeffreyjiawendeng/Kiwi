import { Component, type ErrorInfo, type ReactNode } from "react";
import { DiagnosticScreen } from "./DiagnosticScreen.js";
import { readBridge, type RendererError } from "./bridge.js";
import { TopBar, type WindowAction } from "./TopBar.js";

export interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  failure: RendererError | null;
}

function rendererFailure(): RendererError {
  return {
    code: "KIWI_RENDERER_FAILED",
    message: "A part of the Kiwi window stopped responding.",
    details: {},
    retryable: true,
    recovery_actions: ["retry", "open_logs", "quit"],
    correlation_id: crypto.randomUUID(),
  };
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failure: rendererFailure() };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.failure !== null) {
      const performWindowAction = (action: WindowAction): void => {
        void readBridge()?.performWindowAction(action);
      };
      return (
        <>
          <TopBar
            workspaceTitle={null}
            workspaceStatus={null}
            onOpenQuickSwitch={() => undefined}
            onWindowAction={performWindowAction}
          />
          <main className="shell">
            <DiagnosticScreen error={this.state.failure} />
          </main>
        </>
      );
    }
    return this.props.children;
  }
}
