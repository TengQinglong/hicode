import unittest
from prepare_environment import validate_recipe


class EnvironmentRecipeTests(unittest.TestCase):
    def recipe(self, requirements):
        return {'version': 1, 'python': '3.9.23', 'requirements': requirements,
                'systemPackages': [], 'buildRequirements': [], 'buildEnvironment': {}, 'buildGroups': [], 'provenance': 'reviewed declarations'}

    def test_pinned_public_requirements(self):
        self.assertEqual(validate_recipe(self.recipe(['pytest==8.4.2']))['python'], '3.9.23')

    def test_urls_paths_options_and_unpinned_packages_are_rejected(self):
        for pin in ['pytest', '-r /tmp/hidden', 'pkg @ file:///tmp/reference', 'https://example.com/answer.whl', 'pkg==1; echo bad']:
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                validate_recipe(self.recipe([pin]))

    def test_duplicate_names_and_unsupported_interpreters_fail(self):
        with self.assertRaises(ValueError):
            validate_recipe(self.recipe(['typing_extensions==4.13.2', 'typing-extensions==4.13.2']))
        recipe=self.recipe(['pytest==8.4.2']); recipe['python']='3.9'
        with self.assertRaises(ValueError):
            validate_recipe(recipe)

    def test_build_groups_cannot_add_undeclared_runtime_packages(self):
        recipe=self.recipe(['pytest==8.4.2'])
        recipe['buildGroups']=[{'packages':['unreviewed==1'],'requirements':[]}]
        with self.assertRaises(ValueError):
            validate_recipe(recipe)
