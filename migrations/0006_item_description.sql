-- v3.3: custom form items get an optional description, shown under the
-- question inside the sign-up modal (the Label component's description line,
-- ≤100 chars). Managers set it in the Add/Edit Item modal between Type and
-- the MCQ options.

ALTER TABLE form_items ADD COLUMN description TEXT;
