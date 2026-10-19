import { useCore } from "./hooks/useCore";
import { useVisuals } from "./hooks/useVisuals";
import { useInstances } from "./hooks/useInstances";
import { useVersions } from "./hooks/useVersions";
import { useContent } from "./hooks/useContent";
import { useSkins } from "./hooks/useSkins";
import { useAccounts } from "./hooks/useAccounts";
import { useExternalImport } from "./hooks/useExternalImport";
import { useDragDrop } from "./hooks/useDragDrop";

export function useLauncher() {
  const core = useCore();
  const visuals = useVisuals({ ...core });
  const instances = useInstances({ ...core });
  const versions = useVersions({ ...core, ...instances });
  const content = useContent({ ...core, ...instances });
  const skins = useSkins({ ...core });
  const accounts = useAccounts({ ...core, ...skins });
  const externalImport = useExternalImport({ ...core });
  const dragDrop = useDragDrop({ ...core, ...instances, ...content });
  return { ...core, ...visuals, ...instances, ...versions, ...content, ...skins, ...accounts, ...externalImport, ...dragDrop };
}

export type LauncherState = ReturnType<typeof useLauncher>;
