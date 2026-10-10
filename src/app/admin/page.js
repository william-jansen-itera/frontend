import { redirect } from "next/navigation";
import { ADMIN_SECTIONS, buildAdminHref } from "./adminShared";

function buildSearchParamsString(searchParams) {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== undefined) {
          nextSearchParams.append(key, String(entry));
        }
      });
      continue;
    }

    if (value !== undefined) {
      nextSearchParams.set(key, String(value));
    }
  }

  return nextSearchParams.toString();
}

export default async function AdminPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const searchParamsString = buildSearchParamsString(resolvedSearchParams);
  const requestedVisibility = new URLSearchParams(searchParamsString).get("visibility");
  const defaultSectionHref = ADMIN_SECTIONS[0]?.href || "/admin/deletions";

  redirect(buildAdminHref(defaultSectionHref, searchParamsString, requestedVisibility));
}