# Online Demo Deployment

This demo profile is for showing the product UI and seeded workflows before RDS/Tair are provisioned.
It uses a dedicated system user and PGlite data directory on the existing ECS. It must never receive
real customer, supplier, order, payment, or notification data.

The seeded account is `13800000000` / `demo1234`. Change or remove this profile before commercial use.

The demo and production profiles intentionally use different service names and data paths. Before
production activation, stop and disable `siyan-settlement-666-demo.service`, remove the demo Nginx
listener/configuration, and follow the production preflight and migration procedure in `deploy/README.md`.
