import { PROJECT_PAGE_PURPOSE, type ProjectPage } from "@kiwi/contracts";

/**
 * What a page shows before it has anything to show.
 *
 * A page that renders nothing is indistinguishable from a page that is broken. Every one of
 * these says what the page is for, and, where it is honest to, that it is not built yet.
 * Claiming a feature exists by showing an empty list is worse than saying so.
 */

export interface PageEmptyProps {
  page: ProjectPage;
  title: string;
  children?: React.ReactNode;
  action?: string;
  onAction?: (() => void) | undefined;
}

function Empty({ page, title, children, action, onAction }: PageEmptyProps): React.JSX.Element {
  return (
    <section className="page-empty" aria-labelledby={`${page}-empty-title`}>
      <span>{PROJECT_PAGE_PURPOSE[page]}</span>
      <h3 id={`${page}-empty-title`}>{title}</h3>
      <p>{children ?? "Not built yet. It will open here without changing anything else."}</p>
      {action !== undefined && onAction !== undefined ? (
        <button className="button" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

export const ProjectPages = { Empty };
