"""不访问外网、不读取发布凭证的分发回归测试。"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

spec = importlib.util.spec_from_file_location("publish_update", Path(__file__).with_name("publish-update.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishUpdateTests(unittest.TestCase):
    version = "0.1.15"
    notes = "- 同步斯柯克卡池"

    def manifest(self, version=None):
        return {"version": version or self.version, "notes": "", "platforms": {
            "windows-x86_64": {"url": f"https://old.example/hoyo-auth_{version or self.version}_x64-setup.exe", "signature": "signed-installer"},
        }}

    def fixture(self, directory, *, android=True, notes=None):
        (directory / "latest.json").write_text(json.dumps(self.manifest()), encoding="utf-8")
        (directory / "notes.md").write_text(self.notes if notes is None else notes, encoding="utf-8")
        (directory / f"hoyo-auth_{self.version}_x64-setup.exe").write_bytes(b"installer")
        if android:
            (directory / f"hoyo-auth_{self.version}_android-arm64.apk").write_bytes(b"apk")

    def test_channels_keep_signatures_and_use_independent_downloads(self):
        original = self.manifest()
        domestic, backup, notice = publisher.metadata(self.version, original, self.notes, True)
        self.assertEqual(original["notes"], "")
        for manifest, host in [(domestic, "cnb.cool"), (backup, "github.com")]:
            self.assertEqual(manifest["notes"], self.notes)
            self.assertIn(host, manifest["platforms"]["windows-x86_64"]["url"])
            self.assertEqual(manifest["platforms"]["windows-x86_64"]["signature"], "signed-installer")
        self.assertEqual(notice["gray"], 0)
        self.assertIn("cnb.cool", notice["android"]["url"])
        self.assertIn("github.com", publisher.github_notice(notice)["android"]["url"])
        self.assertNotIn("android", publisher.metadata(self.version, original, self.notes)[2])

    def test_rebranded_installers_keep_their_names_and_signatures_across_channels(self):
        manifest = self.manifest()
        name = f"霜舞工具箱_{self.version}_x64-setup.exe"
        manifest["platforms"]["windows-x86_64"]["url"] = "https://example.com/" + publisher.urllib.parse.quote(name)
        domestic, backup, notice = publisher.metadata(self.version, manifest, self.notes, f"FrostDance_{self.version}_android-arm64.apk")
        for source in [domestic, backup]:
            self.assertEqual(publisher.installer_name(source), name)
            self.assertEqual(source["platforms"]["windows-x86_64"]["signature"], "signed-installer")
        self.assertTrue(publisher.github_notice(notice)["android"]["url"].endswith(f"/FrostDance_{self.version}_android-arm64.apk"))

    def test_rebranded_release_uploads_the_manifest_named_installer(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.fixture(directory, android=False)
            branded = f"霜舞工具箱_{self.version}_x64-setup.exe"
            (directory / f"hoyo-auth_{self.version}_x64-setup.exe").rename(directory / branded)
            manifest = self.manifest()
            manifest["platforms"]["windows-x86_64"]["url"] = "https://example.com/" + publisher.urllib.parse.quote(branded)
            (directory / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
            apk = directory / f"FrostDance_{self.version}_android-arm64.apk"
            apk.write_bytes(b"apk")
            with patch.object(publisher, "check_target"), patch.object(publisher.cnb, "create_or_get_release", return_value="id"), \
                 patch.object(publisher.cnb, "upload_asset") as upload, patch.object(publisher, "github"), \
                 patch.object(publisher, "mirror_oss"), patch.object(publisher, "verify_assets"), patch.object(publisher.cnb, "api"):
                publisher.publish_release(self.version, directory)
                self.assertEqual(Path(upload.call_args_list[0].args[2]).name, branded)
                self.assertEqual(Path(upload.call_args_list[1].args[2]).name, apk.name)

    def test_empty_notes_bad_version_and_unsigned_manifest_are_rejected(self):
        unsigned = self.manifest()
        del unsigned["platforms"]["windows-x86_64"]["signature"]
        for manifest, notes in [(self.manifest(), " \n\t"), (self.manifest("0.1.14"), self.notes), (unsigned, self.notes)]:
            with self.assertRaises(ValueError):
                publisher.metadata(self.version, manifest, notes)
        with self.assertRaises(ValueError):
            publisher.version_tuple("../latest")

    def test_latest_is_promoted_only_after_uploads_mirrors_and_public_verification(self):
        events = []
        def api(method, path, data=None):
            events.append(("api", copy.deepcopy(data)))
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.fixture(directory)
            with patch.object(publisher, "check_target"), \
                 patch.object(publisher.cnb, "create_or_get_release", return_value="release-id"), \
                 patch.object(publisher.cnb, "upload_asset", side_effect=lambda *args: events.append(("upload", Path(args[2]).name))), \
                 patch.object(publisher.cnb, "api", side_effect=api), \
                 patch.object(publisher, "github", side_effect=lambda *args: events.append(("github", args))), \
                 patch.object(publisher, "mirror_oss", side_effect=lambda *args, **kwargs: events.append(("oss", kwargs))), \
                 patch.object(publisher, "verify_assets", side_effect=lambda *args: events.append(("verify", None))):
                publisher.publish_release(self.version, directory)
        self.assertEqual(events[-1], ("api", {"make_latest": "true"}))
        self.assertLess(next(i for i, e in enumerate(events) if e[0] == "oss"), next(i for i, e in enumerate(events) if e[0] == "verify"))
        self.assertTrue({"latest.json", "notice.json", "notes.md"}.issubset({e[1] for e in events if e[0] == "upload"}))

    def test_failed_mirror_never_promotes_cnb_latest(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.fixture(directory)
            with patch.object(publisher, "check_target"), patch.object(publisher.cnb, "create_or_get_release", return_value="id"), \
                 patch.object(publisher.cnb, "upload_asset"), patch.object(publisher, "github"), \
                 patch.object(publisher, "mirror_oss", side_effect=RuntimeError("OSS failure")), patch.object(publisher.cnb, "api") as api:
                with self.assertRaises(RuntimeError):
                    publisher.publish_release(self.version, directory)
                api.assert_not_called()

    def test_gray_retains_android_and_rejects_other_version(self):
        original = {"version": self.version, "gray": 0, "android": {"url": "https://cnb.cool/app.apk"}}
        snapshots = []
        def mirror(version, **kwargs):
            snapshots.append(copy.deepcopy(kwargs["notice"]))
        with patch.object(publisher, "check_target", return_value={"id": "id"}), \
             patch.object(publisher, "read_json", return_value=copy.deepcopy(original)), \
             patch.object(publisher.cnb, "upload_asset"), patch.object(publisher, "github"), \
             patch.object(publisher, "verify_assets"), patch.object(publisher, "mirror_oss", side_effect=mirror):
            publisher.update_gray(self.version, 10)
        self.assertEqual(snapshots[0], {**original, "gray": 10})
        with patch.object(publisher, "latest_release", return_value={"tag_name": "v0.1.16"}):
            with self.assertRaises(ValueError):
                publisher.check_target(self.version, exact=True)
            with self.assertRaises(ValueError):
                publisher.check_target(self.version)

    def test_gray_bootstraps_pre_migration_notice_from_oss(self):
        missing = urllib.error.HTTPError("https://cnb.cool/notice.json", 404, "missing", {}, None)
        old = {"version": "0.1.14", "gray": 10, "android": {"url": "https://cnb.cool/old.apk"}}
        with patch.object(publisher, "check_target", return_value={"id": "id"}), \
             patch.object(publisher, "read_json", side_effect=[missing, old]), \
             patch.object(publisher.cnb, "upload_asset"), patch.object(publisher, "github"), \
             patch.object(publisher, "verify_assets"), patch.object(publisher, "mirror_oss") as mirror:
            publisher.update_gray("0.1.14", 0)
        self.assertEqual(mirror.call_args.kwargs["notice"]["android"], old["android"])
        self.assertEqual(mirror.call_args.kwargs["notice"]["gray"], 0)

    def test_gray_only_overwrites_notice_in_existing_release_without_touching_latest(self):
        notice = {"version": self.version, "gray": 3, "android": {"url": "https://cnb.cool/app.apk"}}
        with patch.object(publisher, "check_target", return_value={"id": "existing-release-id"}) as target, \
             patch.object(publisher, "read_json", return_value=notice), \
             patch.object(publisher.cnb, "create_or_get_release") as create, \
             patch.object(publisher.cnb, "api") as api, \
             patch.object(publisher.cnb, "upload_asset") as upload, \
             patch.object(publisher, "github"), patch.object(publisher, "verify_assets"), patch.object(publisher, "mirror_oss"):
            publisher.update_gray(self.version, 10)
        target.assert_called_once_with(self.version, exact=True)
        create.assert_not_called()
        api.assert_not_called()  # 无 PATCH make_latest / POST 创建 Release。
        upload.assert_called_once()
        self.assertEqual(upload.call_args.args[:2], ("existing-release-id", f"v{self.version}"))
        self.assertEqual(Path(upload.call_args.args[2]).name, "notice.json")

    def test_historical_notes_do_not_replace_live_latest(self):
        def github(*args):
            if args[:2] == ("release", "download"):
                directory = Path(args[args.index("--dir") + 1])
                (directory / "latest.json").write_text(json.dumps(self.manifest()), encoding="utf-8")
        with tempfile.TemporaryDirectory() as temp:
            notes_file = Path(temp) / "notes.md"
            notes_file.write_text(self.notes, encoding="utf-8")
            with patch.object(publisher.cnb, "find_release_id", return_value="id"), \
                 patch.object(publisher, "github", side_effect=github), patch.object(publisher.cnb, "upload_asset"), \
                 patch.object(publisher.cnb, "api") as api, patch.object(publisher, "read_json", return_value={"version": "0.1.16"}), \
                 patch.object(publisher, "verify_assets"), patch.object(publisher, "mirror_oss") as mirror:
                publisher.publish_notes(self.version, notes_file)
            self.assertIsNone(mirror.call_args.kwargs["manifest"])
            self.assertEqual(mirror.call_args.kwargs["notes"], self.notes)
            self.assertFalse(any("make_latest" in call.args[2] for call in api.call_args_list))

    def test_existing_cnb_release_body_is_updated_without_changing_latest(self):
        with patch.object(publisher.cnb, "find_release_id", return_value="id"), patch.object(publisher.cnb, "api") as api:
            publisher.cnb.create_or_get_release("v0.1.11", "title", self.notes)
        self.assertEqual(api.call_args.args[2], {"name": "title", "body": self.notes})

    def test_new_cnb_release_is_staged_without_moving_latest(self):
        with patch.object(publisher.cnb, "find_release_id", return_value=""), patch.object(publisher.cnb, "api", return_value={"id": "new"}) as api:
            self.assertEqual(publisher.cnb.create_or_get_release("v0.1.15", "title", self.notes), "new")
        self.assertTrue(api.call_args.args[2]["draft"])
        self.assertEqual(api.call_args.args[2]["make_latest"], "false")

    def test_oss_keeps_legacy_object_paths_and_notice_schema(self):
        oss = Mock()
        manifest, _, notice = publisher.metadata(self.version, self.manifest(), self.notes, True)
        with patch.object(publisher, "module", return_value=oss):
            publisher.mirror_oss(self.version, manifest=manifest, notice=notice, notes=self.notes)
        self.assertEqual([call.args[0] for call in oss.put.call_args_list], [
            f"updates/releases/v{self.version}.md", "updates/latest.json", "updates/notice.json",
        ])
        self.assertEqual(json.loads(oss.put.call_args_list[-1].args[1]), notice)
        self.assertEqual(oss.verify.call_count, 3)

    def test_public_verification_failure_never_promotes_latest(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.fixture(directory)
            with patch.object(publisher, "check_target"), patch.object(publisher.cnb, "create_or_get_release", return_value="id"), \
                 patch.object(publisher.cnb, "upload_asset"), patch.object(publisher, "github"), \
                 patch.object(publisher, "mirror_oss"), patch.object(publisher, "verify_assets", side_effect=ValueError("not public")), \
                 patch.object(publisher.cnb, "api") as api:
                with self.assertRaises(ValueError):
                    publisher.publish_release(self.version, directory)
                self.assertFalse(any(call.args[2].get("make_latest") == "true" for call in api.call_args_list))


if __name__ == "__main__":
    unittest.main()
