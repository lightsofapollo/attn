<script lang="ts">
  /**
   * The workspace switcher: which project is open, every other project you
   * could open, and the workspace-level actions (new / rename / all).
   *
   * Extracted from Sidebar.svelte (user ruling, 2026-08-20) so the hosted owner
   * header can carry the same control the native sidebar does. It is one
   * component rather than two because the menu's contents — search, the checked
   * current row, the shared dots, the action list — are the same control
   * wherever it is mounted; only the trigger changes register, and that is what
   * `variant` selects.
   */
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import Check from '@lucide/svelte/icons/check';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from '$lib/components/ui/dropdown-menu';
  import * as Command from '$lib/components/ui/command';

  interface Props {
    /** Every project root that can be opened, the current one included. */
    projects: string[];
    /** The project root that is open now. */
    selected: string;
    /** Path → display name. Owned by the caller, which knows about renames. */
    labelFor: (path: string) => string;
    /** Roots with an active review link; marked in the list. */
    sharedProjects?: Set<string>;
    /** Workspace-level actions below the list (new, rename, all workspaces). */
    actions?: { id: string; label: string; run: () => void }[];
    onSwitch?: (path: string) => void;
    /**
     * `sidebar` is the small-caps editorial label the native rail has always
     * used. `header` is the hosted owner header's inline chrome: the document
     * name at the header's own step, sitting beside the wordmark.
     */
    variant?: 'sidebar' | 'header';
  }

  const {
    projects,
    selected,
    labelFor,
    sharedProjects = new Set<string>(),
    actions = [],
    onSwitch,
    variant = 'sidebar',
  }: Props = $props();

  const label = $derived(labelFor(selected));

  let open = $state(false);

  /* Scale the switcher to the number of projects: a single project with no
     actions is just a label — there is nothing to switch to. With actions the
     filter is always shown, because search doubles as keyboard-first selection
     and the menu is a picker rather than a list. */
  const hasMenu = $derived(projects.length > 1 || actions.length > 0);
  const showFilter = $derived(projects.length >= 8 || actions.length > 0);
</script>

{#if hasMenu}
  <DropdownMenu bind:open>
    <DropdownMenuTrigger
      class={variant === 'header' ? 'owner-project-trigger' : 'sidebar-project-trigger'}
      aria-label="Project picker"
      role="combobox"
      aria-expanded={open}
    >
      <!-- The tooltip is the full name only where the path is not a path: a
           hosted workspace root is `/workspace/<id>`, which tells a person
           nothing their own workspace name doesn't. Native keeps the path,
           which is the useful long form of a truncated folder label. -->
      <span
        class={variant === 'header' ? 'owner-project-name' : 'sidebar-project-name'}
        title={variant === 'header' ? label : selected}
      >{label}</span>
      <!-- No chevron in the header (user ruling, 2026-08-20). The trigger sits
           inside a path — mark | workspace | file — and a glyph hanging off the
           middle segment made that path read as two unlike things joined by
           punctuation. The rail keeps its chevron: there the label stands alone
           in a column with nothing else to be confused with. Hover and focus
           carry the affordance here instead. -->
      {#if variant !== 'header'}
        <ChevronsUpDown class="sidebar-project-chevron size-3" />
      {/if}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="sidebar-project-menu p-0">
      <Command.Root class="sidebar-project-command">
        {#if showFilter}
          <Command.Input placeholder="Search projects..." />
        {/if}
        <!-- The scroll cap lives on the ScrollArea viewport so the list gets the
             themed thumb instead of a native gutter. -->
        <ScrollArea viewportClasses="max-h-[300px]">
          <Command.List class="max-h-none overflow-visible">
            <Command.Empty class="px-3 py-5 text-xs text-muted-foreground">
              No projects found.
            </Command.Empty>
            <Command.Group>
              {#each projects as projectPath (projectPath)}
                <Command.Item
                  value={`${labelFor(projectPath)} ${projectPath}`}
                  class="sidebar-project-menu-item"
                  data-current={projectPath === selected}
                  onSelect={() => {
                    open = false;
                    if (projectPath !== selected) onSwitch?.(projectPath);
                  }}
                >
                  <Check
                    class="sidebar-project-check size-3.5"
                    data-active={projectPath === selected}
                  />
                  <span class="sidebar-project-menu-label">{labelFor(projectPath)}</span>
                  {#if sharedProjects.has(projectPath)}
                    <!-- Same rust-dot vocabulary as the ShareChip: this
                         workspace has an active review link. -->
                    <span
                      class="sidebar-project-shared"
                      data-slot="sidebar-project-shared"
                      title="Shared for review"
                    >
                      <span class="sidebar-project-shared-dot" aria-hidden="true"></span>
                      Shared
                    </span>
                  {/if}
                </Command.Item>
              {/each}
            </Command.Group>
          </Command.List>
        </ScrollArea>
      </Command.Root>
      {#if actions.length > 0}
        <DropdownMenuSeparator />
        {#each actions as action (action.id)}
          <DropdownMenuItem
            class="sidebar-project-menu-action"
            onSelect={() => {
              open = false;
              action.run();
            }}
          >
            {action.label}
          </DropdownMenuItem>
        {/each}
      {/if}
    </DropdownMenuContent>
  </DropdownMenu>
{:else}
  <span
    class={variant === 'header'
      ? 'owner-project-name owner-project-name--static'
      : 'sidebar-project-name sidebar-project-name--static'}
    title={selected}
  >{label}</span>
{/if}
