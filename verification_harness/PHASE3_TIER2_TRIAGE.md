# Phase 3 FP Gate - Tier 2 triage worksheet

**Gate (spec section 12): false-positive rate must be < 20%.** Phase 1 ran this on Tier 1 and
got 0%. Tier 2 has never been measured, and it is the only thing blocking Phase 4 sign-off.

Sample: **30 of 1,404** Tier 2 findings from `2022-2023-graduate` (249 pages, the
smallest catalog), stratified by check in rough proportion to volume. Seeded, so this exact
sample reproduces. Mark each **REAL** or **FP**.

| check | in catalog | sampled |
| --- | ---: | ---: |
| `F3` | 1,062 | 15 |
| `B3` | 197 | 6 |
| `F1` | 70 | 3 |
| `B7` | 28 | 2 |
| `F4` | 24 | 2 |
| `B2` | 23 | 2 |

**Context before judging:**

- `F3` is **76% of Tier 2 output** (1,062 of 1,404). If it is largely REAL, the question becomes
  whether to aggregate it like `B4`/`C6` rather than whether to keep it. If largely FP, it needs
  redesign before any full run. Either way it dominates the result.
- **11.3% of Tier 2 findings quoted page text that is not on the page.** Those are already
  demoted to `AMBIGUOUS` and tagged `[EVIDENCE UNVERIFIED]`. Judge them on the claim - and note
  that a model inventing evidence is itself a signal about the rest.

---

### 1. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `bbd47b17-e886-59db-ac4d-0750410eaad0` (page 249)
- **Claim:** The content describes 'Doctor of Pharmacy/MBA Courses' but is placed under a section header for 'Grading Scale for Nursing Programs'.
- **Page evidence:** `## Doctor of Pharmacy/MBA Courses`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 2. `F3` - medium - AMBIGUOUS

- **Entity:** `chunk` `f6d0626c-ab15-50b7-8174-3efbc70c41dd` (page 29)
- **Claim:** The content is an empty string, but the section header is for Isar Kiani. [EVIDENCE UNVERIFIED: the quoted page text was not found on page 29; verdict demoted from CONFIRMED]
- **Page evidence:** `---`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 3. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `8ed977a4-6ffa-518f-a004-2ac80f845da1` (page 231)
- **Claim:** The content describes a Pharmacy course (PHAR-4244) but is placed under a 'Grading Scale for Nursing Programs' header.
- **Page evidence:** `This course examines those topics that provide the foundation for the rational use of pharmacotherapeutic agents in treating central nervous system disorders. The relevant anatomy and physiology of this system is discussed in detail, as are the molecular disease etiologies of the`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 4. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `ed7621a4-695c-58da-89d3-817c9edd3953` (page 85)
- **Claim:** The content 'The School of Business and the Wegmans School of Pharmacy at St. John Fisher University have established a Pharm.D/MBA program. The goal of this cooperative program is to educate students to assume responsibilities with management, executive, and administrative positions within the healthcare pharmaceutical industry, as well as health care delivery systems that provide pharmaceutical information, services, and products to patients.' is incorrectly placed under the section header 'Header 1: Grading Scale for Nursing Programs > Header 2: Doctor of Pharmacy/MBA > Header 3: Overview'. The content describes a Doctor of Pharmacy/MBA program, but the top-level header refers to 'Grading Scale for Nursing Programs'.
- **Page evidence:** `The School of Business and the Wegmans School of Pharmacy at St. John Fisher University have established a Pharm.D/MBA program. The goal of this cooperative program is to educate students to assume responsibilities with management, executive, and administrative positions within t`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 5. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `3ef5def5-396e-5dc7-a672-a77def80dead` (page 113)
- **Claim:** The content '## Enrollment Status' is a header, but the section header breadcrumb 'Header 1: Grading Scale for Nursing Programs > Header 2: Enrollment Status' indicates that 'Enrollment Status' is a sub-header, not the main content.
- **Page evidence:** `## Enrollment Status`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 6. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `aa201830-b3ba-5fb9-b8b5-ce41cb7ad482` (page 85)
- **Claim:** The content '## Application Process' is incorrectly placed under the section header 'Header 1: Grading Scale for Nursing Programs > Header 2: Application Process'. The content describes the application process for the Doctor of Pharmacy/MBA program, but the top-level header refers to 'Grading Scale for Nursing Programs'.
- **Page evidence:** `## Application Process`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 7. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `c20e6d72-9868-5b11-8cde-9447cc7e3709` (page 146)
- **Claim:** The content describes an 'Online M.S. in Library Media' program, but the section header indicates 'New York State Requirements: Childhood Certificates'. The content does not belong under this header.
- **Page evidence:** `## Online M.S. in Library Media`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 8. `F3` - medium - AMBIGUOUS

- **Entity:** `chunk` `1aec31ef-a57f-55f5-bf24-d6b193f63f54` (page 126)
- **Claim:** The content of the chunk is boilerplate and does not belong under the specified section header. [EVIDENCE UNVERIFIED: the quoted page text was not found on page 126; verdict demoted from CONFIRMED]
- **Page evidence:** `---`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 9. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `8947b835-6923-587f-885a-29ddf75bc08d` (page 23)
- **Claim:** The content describes Lawrence Fouraker, but the section header is for Thomas A. Douglas.
- **Page evidence:** `**Lawrence Fouraker**Associate Professor of History*A.B., Harvard College**M.A., Ph.D., University of California*`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 10. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `a5b35935-1c53-5797-bb86-dee19b284a12` (page 82)
- **Claim:** The content is a course description, but the section header indicates it belongs to the 'Wegmans School of Pharmacy' which is a school, not a course.
- **Page evidence:** `This course prepares students to gather, describe, and analyze data to make decisions regarding operations, risk management, finance, marketing, etc. Industry-based applied learning will teach students how to use data to answer questions and solve problems in order to achieve obj`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 11. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `3bf408af-1d2f-5e32-bc6f-1e7d1194d8d8` (page 174)
- **Claim:** The section header 'Header 1: Grading Scale for Nursing Programs > Header 2: GNUR-641 AGNP AC Dx Mgmt Adult (1)' is incorrect for the content provided. The content is a course title, but the first part of the header refers to 'Grading Scale for Nursing Programs'.
- **Page evidence:** `## GNUR-641 AGNP AC Dx Mgmt Adult (1)`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 12. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `3645adb4-c44d-5fae-8d6f-bdc8f9615c1d` (page 32)
- **Claim:** The content of the chunk is not about 'David S. Pate'. The content is about 'Fionnuala Regan'.
- **Page evidence:** `**Fionnuala Regan**
Visiting Instructor of English
*B.A., Bard College*
*M.A., City University of New York*`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 13. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `b1d3a0b7-ee08-5518-9ae2-a58dc030a070` (page 89)
- **Claim:** The content for GMGT-638 Managerial Economics (3) is incorrectly nested under the section header for GMGT-617 Org Behavior in HR Mgmt (3).
- **Page evidence:** `Attributes: TGMB Pre-requisites: GMGT-576 C AND GMGT-580 C Restrictions: Including: -Major: Management Graduate`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 14. `F3` - medium - AMBIGUOUS

- **Entity:** `chunk` `c94d33fb-d62b-5006-a401-fa839ae35da9` (page 174)
- **Claim:** The content '---' is not relevant to the section header 'GNUR-689 Synthesis of the SOI I (1)'. This content appears to be a separator or placeholder rather than descriptive text for the course. [EVIDENCE UNVERIFIED: the quoted page text was not found on page 174; verdict demoted from CONFIRMED]
- **Page evidence:** `---`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 15. `F3` - medium - CONFIRMED

- **Entity:** `chunk` `b4f634a0-1d85-579c-959b-15142b782b31` (page 226)
- **Claim:** The section header 'Grading Scale for Nursing Programs' is incorrect for content describing a Pharmacy course (PHAR 3117).
- **Page evidence:** `## PHAR 3117 - Introduction to Pharmacy Profession (1)`
- **DB evidence:** `Header 1: Grading Scale for Nursing Programs > Header 2: PHAR 3117 - Introduction to Pharmacy Profession (1)`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 16. `B3` - critical - CONFIRMED

- **Entity:** `course` `GNUR 642` (page 175)
- **Claim:** The description in the database does not match the description on the page. The database description appears to be a generic template, while the page provides specific details for this course.
- **Page evidence:** `In this 150-hour clinical experience, adult gerontology nurse practitioner students collaborate with preceptors to provide care for adult clients and their families. Students apply the principles of health assessment, diagnosis, and treatment of common episodic and chronic health`
- **DB evidence:** `In this clinical course, the adult gerontology primary care nurse practitioner students will be paired with a preceptor and meet periodically with faculty in small seminar groups for support and guidance as they develop into the role of the advanced practice nurse. This seminar i`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 17. `B3` - low - CONFIRMED

- **Entity:** `course` `GLMS 606` (page 148)
- **Claim:** description has a minor transcription error
- **Page evidence:** `An immersive standards-aligned inquiry unit planning experience prepares candidates in strategies for effective collaboration intended to meet the needs of diverse learners.`
- **DB evidence:** `In an immersive standards-aligned inquiry unit planning experience prepares candidates in strategies for effective collaboration intended to meet the needs of diverse learners.`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 18. `B3` - critical - CONFIRMED

- **Entity:** `course` `PHAR 3244` (page 230)
- **Claim:** The description in the database for PHAR 3244 is truncated compared to the page, which has no description for PHAR 3244, indicating the database description is likely for a different course.
- **Page evidence:** `## PHAR-3244 Systems Pharmacology II (4)`
- **DB evidence:** `This course examines those topics that provide the foundation for the rational use of pharmacotherapeutic agents in treating disorders of the autonomic nervous system, the respiratory system, the cardiovascular system, and the renal system. The relevant anatomy and physiology of `
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 19. `B3` - low - CONFIRMED

- **Entity:** `course` `GNUR 524` (page 205)
- **Claim:** The database description for GNUR 524 has a minor wording difference compared to the page's description.
- **Page evidence:** `facilitated by the behavior therapy techniques, motivational interviewing and psychoeducational groups.`
- **DB evidence:** `facilitated by the use behavioral therapy techniques, motivational interviewing and psychoeducational groups.`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 20. `B3` - high - CONFIRMED

- **Entity:** `course` `GAED 537` (page 116)
- **Claim:** description is truncated
- **Page evidence:** `New York State and National Council for Social Studies (NCSS) learning standards will be presented to enable teacher candidates to select appropriate curriculum materials, plan lessons, and assess`
- **DB evidence:** `New York State and National Council for Social Studies (NCSS) learning standards will be presented to enable teacher candidates to select appropriate curriculum materials, plan lessons, and assess student learning effectively. This course will also include further development of `
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 21. `B3` - medium - CONFIRMED

- **Entity:** `course` `GMHC 500` (page 189)
- **Claim:** description is truncated
- **Page evidence:** `This course examines the historical movement and professional evolution of the mental health counseling profession, including requirements for licensure. Because effective practitioners must maintain currency in the daily implementation of their skills, the course also explores b`
- **DB evidence:** `This course examines the historical movement and professional evolution of the mental health counseling profession, including requirements for licensure. Because effective practitioners must maintain currency in the daily implementation of their skills, the course also explores b`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 22. `F1` - critical - CONFIRMED

- **Entity:** `course` `PHAR 6702` (page 227)
- **Claim:** The description for PHAR 6702 is missing in the database. The page does not provide individual descriptions for the core courses, only a general overview of APPE rotations.
- **Page evidence:** `## PHAR 6702 - APPE Core Health System (6)`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 23. `F1` - critical - CONFIRMED

- **Entity:** `course` `PHAR 6402` (page 227)
- **Claim:** The description for PHAR 6402 is missing in the database. The page does not provide individual descriptions for the elective courses, only a general overview of APPE rotations.
- **Page evidence:** `## PHAR 6402 - APPE Elective II (6)`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 24. `F1` - critical - CONFIRMED

- **Entity:** `course` `PHAR 5522` (page 243)
- **Claim:** The description for PHAR 5522 in the database actually describes PHAR 5521.
- **Page evidence:** `With the expected rise in the geriatric population, there will be an increased need for health care professionals with training and expertise in geriatric therapeutics. This course is facilitated by an interdisciplinary faculty and focuses on health and quality of life issues of `
- **DB evidence:** `With the expected rise in the geriatric population, there will be an increased need for health care professionals with training and expertise in geriatric therapeutics. This course is facilitated by an interdisciplinary faculty and focuses on health and quality of life issues of `
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 25. `B7` - critical - AMBIGUOUS

- **Entity:** `program` `Master of Science in Sport Management (M.S.)` (page 77)
- **Claim:** total_credits is missing from the database but present on the page. [EVIDENCE UNVERIFIED: the quoted page text was not found on page 77; verdict demoted from CONFIRMED]
- **Page evidence:** `Required Courses - 21 credits`
- **DB evidence:** `None`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 26. `B7` - critical - CONFIRMED

- **Entity:** `program` `Mental Health Counseling M.S.` (page 188)
- **Claim:** total_credits is missing from the database but present on the page.
- **Page evidence:** `You can earn either your master’s degree (60 credits)`
- **DB evidence:** `None`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 27. `F4` - info - AMBIGUOUS

- **Entity:** `page` `99:The database does not capture the gradin` (page 99)
- **Claim:** The database does not capture the grading scheme (e.g., S/U) for courses. [EVIDENCE UNVERIFIED: the quoted page text was not found on page 99; verdict demoted from PLAUSIBLE]
- **Page evidence:** `Graded S/U.`
- **DB evidence:** `course DEXL 705: Field Experience I`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 28. `F4` - info - PLAUSIBLE

- **Entity:** `page` `109:The database does not capture the 'Restr` (page 109)
- **Claim:** The database does not capture the 'Restrictions' information associated with courses, which specifies enrollment limitations based on major.
- **Page evidence:** `Restrictions: Including: -Major: Bldg andDist Educ Leadership, School Leadership`
- **DB evidence:** `course GEDA 506: Achieve Standards Excel`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 29. `B2` - critical - CONFIRMED

- **Entity:** `course` `PHAR 6703` (page 227)
- **Claim:** The database title is completely different from the page title.
- **Page evidence:** `PHAR 6703 - APPE Core Acute Care`
- **DB evidence:** `- Internal Medicine Pharmacy Rotation`
- **Verdict:** `[ ]` REAL   `[ ]` FP

### 30. `B2` - critical - CONFIRMED

- **Entity:** `course` `PHAR 5121` (page 226)
- **Claim:** The database title contains a different acronym ('SIBIRT' vs 'SBIRT').
- **Page evidence:** `PHAR 5121 - IPE: SBIRT`
- **DB evidence:** `- IPE:SIBIRT (0.5)`
- **Verdict:** `[ ]` REAL   `[ ]` FP

---

## Tally

- REAL: ___ / 30
- FP: ___ / 30
- **FP rate: ___%**  (gate: < 20%)
