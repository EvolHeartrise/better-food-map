-- Migration 0023: add the explicit `food` course tag.
-- Applied with: wrangler d1 migrations apply better-food-map --remote (or --local).
--
-- Course tags gain a third member: `food` explicitly marks an item as
-- not-a-dessert-not-a-drink. Every NEW item must carry at least one course tag
-- (enforced by the MCP write path), so "no course tag" now unambiguously means
-- "never course-reviewed" — which is what the missing_course_tag audit check
-- reports. Existing items are NOT bulk-stamped: the backlog drains gradually
-- through that audit so untagged drinks/desserts aren't frozen in as `food`.
INSERT INTO tags (id, name, tag_type) VALUES ('food', 'Food', 'course');
