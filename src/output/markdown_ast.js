/* @flow */

const u = require('unist-builder');
const remark = require('remark');
const mergeConfig = require('../merge_config');
const toc = require('remark-toc');
const links = require('remark-reference-links');
const hljs = require('highlight.js');
const GithubSlugger = require('github-slugger');
const LinkerStack = require('./util/linker_stack');
const rerouteLinks = require('./util/reroute_links');
const _formatType = require('./util/format_type');

const DEFAULT_LANGUAGE = 'javascript';

/**
 * Given a hierarchy-nested set of comments, generate an remark-compatible
 * Abstract Syntax Tree usable for generating Markdown output
 *
 * @param  comments nested comment
 * @param {Object} args currently none accepted
 * @param {boolean} [args.markdownToc=true] whether to include a table of contents
 * in markdown output.
 * @param {Object} [args.hljs={}] config to be passed to highlightjs for code highlighting:
 * consult hljs.configure for the full list.
 * @returns {Promise<Object>} returns an eventual Markdown value
 */
function markdownAST(comments: Array<Comment>, args: Object) {
  return mergeConfig(args).then(config => buildMarkdownAST(comments, config));
}

function buildMarkdownAST(
  comments: Array<Comment>,
  config: DocumentationConfig
) {
  // Configure code highlighting
  const hljsOptions = config.hljs || {};
  hljs.configure(hljsOptions);

  const linkerStack = new LinkerStack(config).namespaceResolver(
    comments,
    namespace => {
      const slugger = new GithubSlugger();
      return '#' + slugger.slug(namespace);
    }
  );

  const formatType = _formatType.bind(undefined, linkerStack.link);

  const generatorComment = [
    u(
      'html',
      '<!-- Generated by documentation.js. Update this documentation by updating the source code. -->'
    )
  ];

  const tableOfContentsHeading = [
    u('heading', { depth: 3 }, [u('text', 'Table of Contents')])
  ];

  /**
   * Generate an AST chunk for a comment at a given depth: this is
   * split from the main function to handle hierarchially nested comments
   *
   * @param {number} depth nesting of the comment, starting at 1
   * @param {Object} comment a single comment
   * @returns {Object} remark-compatible AST
   */
  function generate(depth: number, comment: Comment) {
    function typeSection(comment: Comment) {
      if (comment.type) {
        return u(
          'paragraph',
          [u('text', 'Type: ')].concat(formatType(comment.type))
        );
      } else if (comment.kind) {
        var c = Object.assign(
          {
            type: 'FunctionType'
          },
          comment,
          {
            result:
              comment.returns && comment.returns[0] && comment.returns[0].type
          }
        );

        return u('paragraph', [u('text', 'Type: ')].concat(formatType(c)));
      }
    }

    function paramList(params: Array<CommentTag>) {
      if (params.length === 0) return [];
      return u(
        'list',
        { ordered: false },
        params.map(param =>
          u(
            'listItem',
            [
              u(
                'paragraph',
                [
                  u('inlineCode', param.name),
                  u('text', ' '),
                  !!param.type && u('strong', formatType(param.type)),
                  u('text', ' ')
                ]
                  .concat(param.description ? param.description.children : [])
                  .concat([
                    !!param.default &&
                      u('paragraph', [
                        u('text', ' (optional, default '),
                        u('inlineCode', param.default),
                        u('text', ')')
                      ])
                  ])
                  .filter(Boolean)
              )
            ]
              .concat(param.properties && paramList(param.properties))
              .filter(Boolean)
          )
        )
      );
    }

    function paramSection(comment: Comment) {
      return (
        comment.params.length > 0 && [
          // u('text', 'Parameters:'),
          paramList(comment.params)
        ]
      );
    }

    function propertySection(comment: Comment) {
      return (
        comment.properties.length > 0 && [
          // u('text', 'Properties:'),
          propertyList(comment.properties)
        ]
      );
    }

    function propertyList(properties: Array<CommentTag>) {
      return u(
        'list',
        { ordered: false },
        properties.map(property =>
          u(
            'listItem',
            [
              u(
                'paragraph',
                [
                  u('inlineCode', property.name),
                  u('text', ' '),
                  u('strong', formatType(property.type)),
                  u('text', ' ')
                ]
                  .concat(
                    property.description ? property.description.children : []
                  )
                  .filter(Boolean)
              ),
              property.properties && propertyList(property.properties)
            ].filter(Boolean)
          )
        )
      );
    }

    function examplesSection(comment: Comment) {
      return (
        comment.examples.length > 0 &&
        [u('text', 'Examples:')].concat(
          comment.examples.reduce(function(memo, example) {
            const language = hljsOptions.highlightAuto
              ? hljs.highlightAuto(example.description).language
              : DEFAULT_LANGUAGE;
            return memo
              .concat(
                example.caption
                  ? [u('paragraph', [u('emphasis', example.caption)])]
                  : []
              )
              .concat([u('code', { lang: language }, example.description)]);
          }, [])
        )
      );
    }

    function returnsSection(comment: Comment) {
      return (
        comment.returns.length > 0 &&
        comment.returns.map(returns =>
          u(
            'paragraph',
            [
              u('text', 'Returns:'),
              u('text', ' '),
              u('strong', formatType(returns.type)),
              u('text', ' ')
            ].concat(returns.description ? returns.description.children : [])
          )
        )
      );
    }

    function throwsSection(comment: Comment) {
      return (
        comment.throws.length > 0 &&
        u(
          'list',
          { ordered: false },
          comment.throws.map(returns =>
            u('listItem', [
              u(
                'paragraph',
                [
                  u('text', 'Throws:'),
                  u('text', ' '),
                  u('strong', formatType(returns.type)),
                  u('text', ' ')
                ].concat(
                  returns.description ? returns.description.children : []
                )
              )
            ])
          )
        )
      );
    }

    function augmentsLink(comment: Comment) {
      return (
        comment.augments.length > 0 &&
        u('paragraph', [
          u('strong', [
            u('text', 'Extends: '),
            u('text', comment.augments.map(tag => tag.name).join(', '))
          ])
        ])
      );
    }

    function seeLink(comment: Comment) {
      return (
        comment.sees.length > 0 &&
        u(
          'list',
          { ordered: false },
          comment.sees.map(see =>
            u('listItem', [
              u('strong', [u('text', 'See: ')].concat(see.children))
            ])
          )
        )
      );
    }

    function githubLink(comment: Comment) {
      return (
        comment.context &&
        comment.context.github &&
        u('paragraph', [
          u('text', 'Source: '),
          u(
            'link',
            {
              title: 'Source code on GitHub',
              url: comment.context.github.url
            },
            [
              u(
                'text',
                comment.context.github.path +
                  ':' +
                  comment.context.loc.start.line
              )
            ]
          )
        ])
      );
    }

    function metaSection(comment: Comment) {
      const meta = [
        'version',
        'since',
        'copyright',
        'author',
        'license',
        'deprecated'
      ].filter(tag => comment[tag]);
      return (
        !!meta.length &&
        [u('strong', [u('text', 'Meta')])].concat(
          u(
            'list',
            { ordered: false },
            meta.map(tag => {
              let metaContent;
              if (tag === 'copyright' || tag === 'deprecated') {
                metaContent = comment[tag];
              } else {
                metaContent = u('text', comment[tag]);
              }
              return u('listItem', [
                u('paragraph', [
                  u('strong', [u('text', tag)]),
                  u('text', ': '),
                  metaContent
                ])
              ]);
            })
          )
        )
      );
    }

    if (comment.kind === 'note') {
      return [u('heading', { depth }, [u('text', comment.name || '')])]
        .concat(comment.description)
        .concat(
          !!comment.members.static.length &&
            comment.members.static.reduce(
              (memo, child) => memo.concat(generate(depth + 1, child)),
              []
            )
        )
        .filter(Boolean);
    }

    var heading = [u('text', comment.name || '')];
    if (comment.context && comment.context.github) {
      heading = [
        u(
          'link',
          {
            url: comment.context.github.url
          },
          heading
        )
      ];
    }

    return (
      [u('thematicBreak')]
        .concat([u('heading', { depth }, heading)])
        .concat(augmentsLink(comment))
        .concat(seeLink(comment))
        .concat(comment.description ? comment.description.children : [])
        .concat(typeSection(comment))
        .concat(paramSection(comment))
        .concat(propertySection(comment))
        .concat(throwsSection(comment))
        // .concat(returnsSection(comment))
        // .concat(githubLink(comment))
        .concat(examplesSection(comment))
        .concat(metaSection(comment))
        .concat(
          !!comment.members.global.length &&
            comment.members.global.reduce(
              (memo, child) => memo.concat(generate(depth + 1, child)),
              []
            )
        )
        .concat(
          !!comment.members.instance.length &&
            comment.members.instance.reduce(
              (memo, child) => memo.concat(generate(depth + 1, child)),
              []
            )
        )
        .concat(
          !!comment.members.static.length &&
            comment.members.static.reduce(
              (memo, child) => memo.concat(generate(depth + 1, child)),
              []
            )
        )
        .concat(
          !!comment.members.inner.length &&
            comment.members.inner.reduce(
              (memo, child) => memo.concat(generate(depth + 1, child)),
              []
            )
        )
        .filter(Boolean)
    );
  }

  let root = rerouteLinks(
    linkerStack.link,
    u(
      'root',
      generatorComment
        .concat(config.markdownToc ? tableOfContentsHeading : [])
        .concat(
          comments.reduce(
            (memo, comment) => memo.concat(generate(2, comment)),
            []
          )
        )
        .concat([u('thematicBreak')])
    )
  );

  const pluginRemark = remark();
  if (config.markdownToc) pluginRemark.use(toc, { tight: true });
  if (config.noReferenceLinks !== true) pluginRemark.use(links);
  root = pluginRemark.run(root);

  return Promise.resolve(root);
}

module.exports = markdownAST;
