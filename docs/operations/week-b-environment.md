# Week B: temporary load-test environment on Oracle Cloud (plan, not provisioned)

Status: **proposal, waiting for approval.** Nothing has been created.

**Gate before anything is created** (agreed 2026-11-11): both of these must be working.
1. **Off-VM backups.** A boot-volume backup policy, or regular dump copies off the VM, with one restore actually tested.
2. **External uptime monitoring.** HTTPS keyword check on `/health/deep` and a TCP check on 8883, alerting by email.

## What gets created

| Resource | Configuration | Why |
|---|---|---|
| Compartment `arc-loadtest` | under the root compartment | everything in one place: one budget, one teardown, nothing mixed with production |
| VCN `arc-loadtest-vcn` | `10.40.0.0/16`, one public subnet `10.40.1.0/24`, internet gateway; **no peering or DRG to the production VCN** | network isolation |
| Security list | inbound: 22/tcp from your public IP only; 443 and 8883 **only from 10.40.0.0/16**. Outbound: all (image and package downloads) | the stack is never reachable from the internet |
| **Test server** `arc-loadtest-1` | `VM.Standard.A1.Flex`, **2 OCPU, 12 GB**, Canonical Ubuntu 24.04 aarch64, 100 GB boot volume (Balanced), region **India South (Hyderabad)** | same shape, OS, disk and region as production |
| **Load generator** `arc-loadgen-1` | `VM.Standard.A1.Flex`, 2 OCPU, 4 GB, Ubuntu 24.04 aarch64, 50 GB boot volume | load must come from another machine, or the generator steals CPU from the system under test |
| Tags | `arc-env=loadtest` on every resource | cost report and teardown check |
| SSH key | a new key pair only for this environment | a leaked test key gives no access to production |

**Software on the test server:** the production stack, started with `tests/stack/up.sh`. That is the production compose file, images and EMQX configuration. Caddy's internal CA replaces Let's Encrypt, and host names `*.arc.test` live in `/etc/hosts`, so **no DNS records under arclabs.in** are touched. Secrets are generated fresh on the VM. **No production data** is copied: test organizations and devices are synthetic, because production holds personal data (DPDP).

**Software on the generator:** k6 for the HTTPS API and `emqtt-bench` for MQTT. Both point at the test server's private IP.

## Cost estimate

Rates as published by Oracle (list prices in USD; an India-billed account pays the INR price list, which can differ):

| Item | Rate | Source |
|---|---|---|
| A1 compute | $0.01 per OCPU-hour, $0.0015 per GB-hour | [Oracle: Arm-based compute](https://www.oracle.com/cloud/compute/arm/) (page updated 2026-10-09) |
| Block volume performance (Balanced, 10 VPU) | $0.017 per GB-month | [Oracle: Block Volume pricing](https://www.oracle.com/cloud/storage/block-volumes/pricing) |
| Block volume storage | $0.0255 per GB-month | Oracle list price as I know it; **not confirmed on the page today** (the figure didn't load). Confirm in the console's cost estimator |

| Item | Per day | 7 days | 10 days |
|---|---|---|---|
| Test server (2 OCPU, 12 GB) | $0.91 | $6.38 | $9.12 |
| Load generator (2 OCPU, 4 GB) | $0.62 | $4.37 | $6.24 |
| Boot volumes (150 GB, Balanced) | $0.21 | $1.49 | $2.13 |
| **Total, worst case** | **$1.75** | **$12.24** | **$17.49** |

**Worst case** assumes no free allowance is left, because the production VM already uses the Always Free 2 OCPU / 12 GB.

**Best case:** compute costs nothing, and only the boot volumes (~$1.5 for 7 days) are billed. Whether this applies is **unclear**:
- Oracle halved the Always Free A1 allowance on 15 June 2026, to 1,500 OCPU-hours / 9,000 GB-hours a month ([InfoQ, July 2026](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)).
- Oracle's Block Volume pricing page still says "each paid tenancy gets the first 3,000 OCPU hours and 18,000 GB hours per month for free".
- Support agents reportedly told users that paid tenancies keep 4 OCPU / 24 GB.
- Production uses 1,440 OCPU-hours and 8,640 GB-hours a month. If the 3,000 / 18,000 figure applies, the Week B compute (672 OCPU-hours, 2,688 GB-hours for 7 days) fits inside it.

**Network:** traffic inside the VCN isn't charged, and test traffic to the internet is negligible.

**Public IPs:** I don't know the current charge for an ephemeral public IP. Check the cost report after day 1.

## Spending limit

- **Proposed cap: USD 25 (≈ ₹2,200; INR figure approximate).** That is about 40% above the 10-day worst case.
- An **OCI budget** on compartment `arc-loadtest` of ₹2,000, with email alerts at 25%, 50%, 80% and 100% (forecast and actual).
- **An OCI budget only alerts. It does not stop or delete anything.** The real limit is the teardown date: **everything is deleted at the end of Week B, or on day 10 at the latest**, whichever comes first. Cost Analysis gets checked every day, filtered on `arc-env=loadtest`.

## Account change this requires (decision for you)

Creating billed resources needs the tenancy upgraded from Free Tier to **Pay As You Go**, with a card on file.
- **Dangerous / one-way:** as far as I know, the upgrade can't be undone. After it, any resource beyond the free allowance is billed instead of refused. That includes mistakes in production, such as a larger shape or extra volumes.
- **Possible benefit, not confirmed by Oracle:** users report that PAYG tenancies are not subject to Always Free idle-VM reclamation.
- **Mandatory if you upgrade:** a tenancy-wide budget alert (for example ₹500 a month) in addition to the compartment budget, so a production mistake is noticed within a day.

## Isolation from production

| Risk | Control |
|---|---|
| Test traffic or scans reach production | test hosts are `*.arc.test` in `/etc/hosts`; no DNS changes; generator configs use the test server's private IP only |
| Shared credentials | fresh `secrets.env` on the test server; new SSH key; no production env files copied |
| Network path between the two | separate VCN, no peering, no DRG; production's security lists unchanged |
| Personal data | synthetic data only; no production dump restored |
| Cost leak | compartment budget, tags, daily check, fixed teardown date |

## Teardown (Oracle console)

1. **Compute → Instances** in compartment `arc-loadtest`: *Terminate* both instances. Tick **Permanently delete the attached boot volume**.
2. **Storage → Block Volumes / Boot Volumes / Backups** in `arc-loadtest`: confirm nothing is left. Delete anything listed.
3. **Networking → Virtual Cloud Networks → `arc-loadtest-vcn` → Delete.** This removes the subnet, internet gateway, route table and security list.
4. **Identity → Compartments → `arc-loadtest` → Delete** (allowed once it's empty; deletion completes in the background).
5. **Next day:** in **Billing → Cost Analysis**, filtered by tag `arc-env=loadtest`, the cost must be flat. Search **Governance → Tenancy Explorer** for the tag; it must return nothing.
6. Delete the compartment budget after the month's invoice shows the final amount.
7. On your Mac: delete the load-test SSH key and any `*.arc.test` lines in `/etc/hosts`.

The production VM, its VCN, DNS and backups are not touched at any step.

## Results

Week B results (k6, emqtt-bench, endurance, recovery drills) will be recorded in `docs/operations/` next to the Week A evidence.
