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
disables the legacy tag-push job and enables `release-publish.yml` atomically.

After cutover, do not push release tags directly. Dispatch the candidate and
publisher workflows through the trusted release pipeline. The sealed publisher
stages an exact draft, verifies its notes and asset bytes, and publishes only the
complete draft. An interrupted run can resume an exact matching draft; it
refuses drafts with mismatched metadata or bytes and never overwrites an
existing asset.
