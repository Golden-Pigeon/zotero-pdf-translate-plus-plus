import { normalizeRawText } from "../src/utils/task";

describe("task raw normalization", function () {
  it("replaces control characters such as newlines with spaces", function () {
    assert.equal(
      normalizeRawText("first line\nsecond line\tend"),
      "first line second line end",
    );
  });

  it("applies NFKC so PDF artifacts fold to plain text", function () {
    assert.equal(normalizeRawText("cafe\u00A0latte"), "cafe latte");
    assert.equal(normalizeRawText("ﬁle"), "file");
    assert.equal(normalizeRawText("ＡＢＣ"), "ABC");
  });

  it("is idempotent so popup re-fires match the existing task", function () {
    const raw = "line one\nline two\u00A0end ﬁx";
    assert.equal(normalizeRawText(raw), normalizeRawText(normalizeRawText(raw)));
  });
});
