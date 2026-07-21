import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "quiet";
};

export function Button({ busy = false, children, className = "", disabled, variant = "secondary", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      <span>{busy ? "처리 중…" : children}</span>
    </button>
  );
}

type SectionHeaderProps = {
  action?: ReactNode;
  description?: ReactNode;
  title: string;
};

export function SectionHeader({ action, description, title }: SectionHeaderProps) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </div>
  );
}

type StatusBadgeProps = {
  children: ReactNode;
  className?: string;
};

export function StatusBadge({ children, className = "" }: StatusBadgeProps) {
  return <span className={`status-badge ${className}`.trim()}>{children}</span>;
}

type WorkflowStepsProps = {
  currentStep: 1 | 2 | 3;
};

const workflowSteps = [
  { href: "#controls", label: "이미지 조정", step: 1 },
  { href: "#compare", label: "결과 비교", step: 2 },
  { href: "#export", label: "파일 저장", step: 3 },
] as const;

export function WorkflowSteps({ currentStep }: WorkflowStepsProps) {
  return (
    <nav className="workflow-nav" aria-label="이미지 보정 단계">
      <ol>
        {workflowSteps.map(({ href, label, step }) => {
          const state = step < currentStep ? "complete" : step === currentStep ? "current" : "upcoming";

          return (
            <li key={href} data-state={state}>
              <a href={href} aria-current={state === "current" ? "step" : undefined}>
                <span aria-hidden="true">{step}</span>
                <strong>{label}</strong>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
