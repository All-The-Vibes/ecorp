-- Human intent uses the native aggregate without a publisher attempt or lease.
-- Preserve the existing applied migration and add its admission operation here.
ALTER TABLE pull_request_publication_operations
    DROP CONSTRAINT pull_request_publication_operations_operation_check;

ALTER TABLE pull_request_publication_operations
    ADD CONSTRAINT pull_request_publication_operations_operation_check
    CHECK (operation IN (
        'request', 'start', 'renew', 'branch_pushed',
        'pull_request_created', 'published', 'failed'
    ));
