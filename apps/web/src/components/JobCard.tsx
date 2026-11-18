import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatPay, formatRange } from "../lib/format";
import { jobDisplay } from "../lib/labels";
import { useReference } from "../lib/reference";
import type { Job } from "../lib/types";
import { CategoryImage } from "./CategoryImage";
import { Badge, Fact } from "./ui";

export function employerLabel(job: Job): string {
  const e = job.employer;
  if (!e) return "Employer";
  return e.org_name ? `${e.org_name} (${e.full_name})` : e.full_name;
}

/** Summary card for a job, used in browse, applications, bookings and the employer's list. */
export function JobCard({ job, to, showEmployer = true, footer }: { job: Job; to: string; showEmployer?: boolean; footer?: ReactNode }) {
  const { categories, categoryName, localityName } = useReference();
  const slug = categories.find((c) => c.id === job.category_id)?.slug;
  const status = jobDisplay(job);
  const left = Math.max(job.workers_needed - job.positions_filled, 0);

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-paper shadow-sm transition-shadow hover:shadow-md sm:grid sm:grid-cols-[11rem_1fr]">
      <CategoryImage slug={slug} name={categoryName(job.category_id)} className="h-36 w-full sm:h-full" />
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-xl">
            <Link to={to} className="underline decoration-terracotta decoration-2 underline-offset-4 hover:text-terracotta-darker">
              {job.title}
            </Link>
          </h2>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <p className="mt-1 text-ink-soft">
          {categoryName(job.category_id)} · {localityName(job.locality_id)}
          {showEmployer && job.employer !== undefined && <> · {employerLabel(job)}</>}
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Fact label="When">{formatRange(job.starts_at, job.ends_at)}</Fact>
          <Fact label="Pay">{formatPay(job.pay_amount_paise, job.pay_type)}</Fact>
          <Fact label="Workers">
            {job.positions_filled} of {job.workers_needed} booked{job.status === "open" && left > 0 ? ` · ${left} needed` : ""}
          </Fact>
        </dl>
        {footer && <div className="mt-4 flex flex-wrap items-center gap-3">{footer}</div>}
      </div>
    </article>
  );
}
