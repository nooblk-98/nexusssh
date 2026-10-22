# Organizing servers

- Use **+ → Folder** to create a top-level folder.
- Right-click a folder and choose **New Subfolder** to create a folder inside it, or **New Server** to add a server there.
- Drag a server or folder onto a destination folder. Moving a folder also moves its subfolders and servers. The destination expands after the move.
- To move something out of a folder, drop it on **Move to top level**, which appears during dragging, or on empty space in the server list.
- Alternatively, right-click a server or folder, choose **Move to…**, and select a destination or **Top level**.

Folder selectors display full paths. Search matches server details and folder names, and temporarily expands ancestors to show matching items. Clearing the search restores the saved expanded/collapsed state.

Folders may have the same name in different parents, but not in the same parent. A folder cannot be moved into itself or one of its descendants. Moves are restricted to the current workspace and require an owner or administrator.

Deleting a folder keeps its contents: direct servers and subfolders move to the top level, with deeper contents preserved. If a subfolder would conflict with a top-level name, rename or move it before deleting the parent.

JSON server exports include a `folderPath` array, preserving nested folders on import. Older exports and CSV files with a single `folder` name remain supported. Empty folders are not included in server exports.

The nested-folder migration keeps existing folders and servers in place. Deployments apply it with the normal database migration command before starting the updated API.
