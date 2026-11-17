import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";

const OPTIONS = [
  { value: "returned", label: "Recently returned" },
  { value: "priority", label: "Priority" },
] as const;

export function InboxOrderControl(props: { readonly variant: "standalone" | "card" }) {
  const { inboxSortOrder, setInboxSortOrder } = useThreadListV2ShelfPreferences();
  return (
    <SegmentedControl
      size="compact"
      variant={props.variant}
      role="button"
      options={OPTIONS}
      selected={inboxSortOrder}
      onSelect={setInboxSortOrder}
    />
  );
}
