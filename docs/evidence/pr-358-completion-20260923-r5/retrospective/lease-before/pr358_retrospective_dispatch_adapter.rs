// Compatibility-only callback bridge; the regression assertions are shared.
impl PgStore {
    async fn retrospective_progress_dispatch<F>(
        &self, command: &PendingRunnerCommand, dispatch: F,
    ) -> Result<RunnerCommandDispatchOutcome>
    where F: FnOnce(Option<Uuid>) -> Result<bool> {
        self.with_progress_command_dispatch(command, || dispatch(None).expect("regression callback returned error")).await
    }
}
