-- Reuse the publication operation ledger for native ready/draft compensation.
-- Private capabilities stay in publisher_token; public provenance has no tokens.
ALTER TABLE pull_request_publication_operations
    DROP CONSTRAINT pull_request_publication_operations_operation_check;
ALTER TABLE pull_request_publication_operations
    ADD CONSTRAINT pull_request_publication_operations_operation_check CHECK (
        operation IN (
            'start', 'renew', 'branch_pushed', 'pull_request_created', 'published',
            'failed', 'checkpoint_readiness'
        )
    );
