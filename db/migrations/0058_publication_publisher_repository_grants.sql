-- Existing credentials retain only their human-authenticated direct CLI access.
-- Workload queue access requires a repository explicitly granted at enrollment.
ALTER TABLE publication_publisher_credentials
    ADD COLUMN repository TEXT
        CHECK (repository IS NULL OR
               repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$');
