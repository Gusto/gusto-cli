# Release automation

Release candidates are built only by manually dispatching
`.github/workflows/release-candidate.yml`. Do not add a GitHub `push` trigger to
that workflow: the trusted main-push pipeline dispatches it with the intended
version and commit SHA after its own checks pass.

## Publisher cutover

The repository variable `RELEASE_AUTOMATION_CUTOVER` selects the only enabled
publisher. Before cutover, leave it unset; tag pushes continue to use the legacy
`release.yml` workflow and the sealed publisher refuses to schedule its write
job. To cut over, set the variable to the exact value `sealed-v1`. The two
publisher jobs use complementary conditions, so that single variable update
selects exactly one path for newly evaluated jobs. Both publishers also share
the `release-publication` concurrency group, so their publication jobs cannot
run simultaneously.

The variable update does not revoke a legacy job that was already admitted.
Use this cutover procedure:

1. Stop direct release-tag pushes and sealed-publisher dispatches.
2. Let every queued or in-progress `release.yml` run finish, or cancel each run
   explicitly with `gh run cancel <run-id>`.
3. Verify no non-completed legacy run remains. This command must print `[]`:

   ```sh
   gh api --paginate --slurp \
     'repos/Gusto/gusto-cli/actions/workflows/release.yml/runs?per_page=100' \
     --jq '[.[].workflow_runs[] | select(.status != "completed") | {id, status}]'
   ```

4. Set `RELEASE_AUTOMATION_CUTOVER` to the exact value `sealed-v1`, then verify
   that value before dispatching the sealed publisher.
5. Resume the trusted release pipeline. Do not dispatch `release-publish.yml`
   until the variable has been verified.

After cutover, do not push release tags directly. Dispatch the candidate and
publisher workflows through the trusted release pipeline. The sealed publisher
stages an exact draft, verifies its notes and asset bytes, and publishes only the
complete draft. An interrupted run can resume an exact matching draft; it
refuses drafts with mismatched metadata or bytes and never overwrites an
existing asset.
