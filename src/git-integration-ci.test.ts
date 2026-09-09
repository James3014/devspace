process.env.GIT_AUTHOR_NAME = "DevSpace CI Test";
process.env.GIT_AUTHOR_EMAIL = "devspace-ci@example.com";
process.env.GIT_COMMITTER_NAME = "DevSpace CI Test";
process.env.GIT_COMMITTER_EMAIL = "devspace-ci@example.com";

await import("./git-integration.test.js");
