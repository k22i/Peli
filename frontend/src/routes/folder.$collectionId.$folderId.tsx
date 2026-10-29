import { createFileRoute } from "@tanstack/react-router";

import { FolderPage } from "@/components/folder/folder-page";

export const Route = createFileRoute("/folder/$collectionId/$folderId")({
  component: FolderPage,
});
